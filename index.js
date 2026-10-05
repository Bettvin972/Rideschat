require('dotenv').config();

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Op } = require('sequelize');
const {
  sequelize,
  User,
  RideRequest,
  RideOffer,
  initDatabase,
  cleanupDatabase,
  createRideSafely,
  claimRideSafely,
  completeRideSafely,
  cancelRideSafely,
  findUserActiveRide,
  findUserOpenRequests,
  findMatchingRides,
} = require('./database');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const PORT = Number(process.env.PORT || 10000);
const AUTH_PATH = path.join(__dirname, 'auth_info');
const PAGE_SIZE = 15;
const DRIVER_ONLINE_HOURS = 2;
const MAX_SEATS = 6;
const MAX_LOCATION_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_NAME_LENGTH = 80;
const MAX_RIDE_LIFETIME_HOURS = 24;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;
const EXPIRY_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 45 * 60 * 1000;
const MESSAGE_DEDUP_TTL_MS = 10 * 60 * 1000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = ['openai/gpt-oss-20b'];

let sock = null;
let qrLast = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let startingWhatsApp = false;
let shuttingDown = false;
let dbReady = false;
let server = null;

const userSessions = new Map();
const activeChats = new Map();
const ratingSessions = new Map();
const endingLocks = new Set();
const userQueues = new Map();
const processedMessages = new Map();
const notificationLocks = new Map();

function log(level, message, meta = undefined) {
  const suffix = meta === undefined ? '' : ` ${safeJson(meta)}`;
  const line = `[${new Date().toISOString()}] ${message}${suffix}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return '[unserializable]'; }
}

function logError(prefix, err) {
  const details = err?.response?.data || err?.data || err;
  log('error', prefix, {
    message: details?.message || err?.message || String(err),
    stack: details?.stack || err?.stack,
  });
}

function normalizePhone(value) {
  if (!value) return '';
  return String(value).split('@')[0].replace(/[^0-9]/g, '');
}

function canonicalPhone(realPhone, remoteJid) {
  return normalizePhone(realPhone) || normalizePhone(remoteJid);
}

function getJid(phoneOrJid) {
  if (!phoneOrJid) return '';
  const raw = String(phoneOrJid);
  if (raw.includes('@')) return raw;
  const digits = normalizePhone(raw);
  return digits ? `${digits}@s.whatsapp.net` : '';
}

function getDirectChatLink(jid) {
  const number = normalizePhone(jid);
  return number ? `https://wa.me/${number}` : '';
}

function clampInteger(value, min, max, fallback = null) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, maxLength = MAX_MESSAGE_LENGTH) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function getSession(phone) {
  const key = normalizePhone(phone) || String(phone || '');
  let session = userSessions.get(key);
  if (!session) {
    session = {
      draft: {},
      ridesList: [],
      ridesPage: 0,
      lastTitle: 'RIDES:',
      lastUpdated: Date.now(),
      lastIntent: null,
      lastPrompt: null,
    };
    userSessions.set(key, session);
  }
  session.lastUpdated = Date.now();
  return session;
}

function clearSession(phone) {
  const key = normalizePhone(phone) || String(phone || '');
  userSessions.delete(key);
}

function queueUserMessage(phone, task) {
  const key = normalizePhone(phone) || String(phone || 'unknown');
  const previous = userQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .catch(err => logError(`User queue error [${key}]`, err));
  userQueues.set(key, next);
  next.finally(() => {
    if (userQueues.get(key) === next) userQueues.delete(key);
  }).catch(() => {});
  return next;
}

function rememberMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > MESSAGE_DEDUP_TTL_MS) processedMessages.delete(id);
  }
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

function detectUserRegion(jid) {
  const digits = normalizePhone(jid);
  if (digits.startsWith('254') || (digits.startsWith('0') && digits.length === 10)) {
    return {
      country: 'KE',
      timezone: 'Africa/Nairobi',
      defaultCity: 'Juja',
      defaultDestination: 'Nairobi',
      examplePlaces: 'Juja or Ruiru',
      exampleDest: 'Thika or Nairobi',
      currency: 'KES',
    };
  }
  if (digits.startsWith('1') || (digits.length === 10 && !digits.startsWith('0'))) {
    return {
      country: 'US',
      timezone: 'America/Chicago',
      defaultCity: 'Denton',
      defaultDestination: 'Dallas',
      examplePlaces: 'Denton or Frisco',
      exampleDest: 'Dallas or Fort Worth',
      currency: 'USD',
    };
  }
  return {
    country: 'US',
    timezone: 'America/Chicago',
    defaultCity: 'Main Campus',
    defaultDestination: 'Downtown',
    examplePlaces: 'Campus or North Side',
    exampleDest: 'Downtown or Station',
    currency: 'USD',
  };
}

function getLocalParts(date = new Date(), timezone = 'America/Chicago') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function getLocalDateString(date = new Date(), timezone = 'America/Chicago') {
  const p = getLocalParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function getLocalTimeString(date = new Date(), timezone = 'America/Chicago') {
  const p = getLocalParts(date, timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function getTimeGreeting(timezone) {
  const hour = Number(getLocalParts(new Date(), timezone).hour);
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Hello';
}

function addCalendarDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function localDatePlusDays(days, timezone) {
  return getLocalDateString(addCalendarDays(new Date(), days), timezone);
}

function getNextWeekday(targetDay, timezone) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const target = days.indexOf(String(targetDay || '').toLowerCase());
  if (target < 0) return null;
  const currentName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' })
    .format(new Date()).toLowerCase();
  const current = days.indexOf(currentName);
  let diff = target - current;
  if (diff <= 0) diff += 7;
  return localDatePlusDays(diff, timezone);
}

function parseExplicitDate(value) {
  const s = String(value || '').trim();
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return s;
}

function getRealDate(aiDate, timezone, referenceDate = new Date()) {
  const today = getLocalDateString(referenceDate, timezone);
  if (!aiDate) return null;
  const s = String(aiDate).toLowerCase().trim();
  const explicit = parseExplicitDate(s);
  if (explicit) return explicit;
  if (s.includes('day after tomorrow')) return localDatePlusDays(2, timezone);
  if (s.includes('tomorrow')) return localDatePlusDays(1, timezone);
  if (s.includes('today') || s === 'now' || s === 'asap') return today;
  if (s.includes('next week')) return localDatePlusDays(7, timezone);
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const weekday of weekdays) {
    if (s.includes(weekday)) return getNextWeekday(weekday, timezone);
  }
  return null;
}

function getRealTime(aiTime, timezone) {
  if (!aiTime) return null;
  let value = String(aiTime).toLowerCase().trim().replace(/\./g, '');
  const wordMap = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
    seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  };
  for (const [word, number] of Object.entries(wordMap)) {
    value = value.replace(new RegExp(`\\b${word}\\b`, 'g'), number);
  }
  if (['now', 'asap', 'immediately', 'right now', 'now now'].includes(value)) {
    return getLocalTimeString(new Date(), timezone);
  }
  if (/\b(this )?morning\b/.test(value)) return '09:00';
  if (/\b(this )?afternoon\b/.test(value)) return '14:00';
  if (/\b(late afternoon)\b/.test(value)) return '16:00';
  if (/\b(evening|tonight)\b/.test(value)) return '19:00';
  const amPm = value.match(/\b(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)\b/);
  if (amPm) {
    let hour = Number(amPm[1]);
    const minute = Number(amPm[2] || 0);
    const period = amPm[3];
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    if (period === 'pm' && hour < 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const twentyFour = value.match(/\b(\d{1,2}):(\d{2})\b/);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const bareHour = value.match(/^\b(\d{1,2})\s*(am|pm)\b$/);
  if (bareHour) return getRealTime(`${bareHour[1]} ${bareHour[2]}`, timezone);
  return null;
}

function toDisplayTime(time) {
  if (!time) return 'Time not set';
  if (time === 'Flexible') return 'Flexible';
  const parts = String(time).split(':');
  const hour = Number.parseInt(parts[0], 10);
  const minute = Number.parseInt(parts[1] || '0', 10);
  if (!Number.isFinite(hour)) return String(time);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function toDisplayDate(date, timezone) {
  if (!date) return 'Date not set';
  const value = String(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const today = getLocalDateString(new Date(), timezone);
  const tomorrow = localDatePlusDays(1, timezone);
  if (value === today) return 'Today';
  if (value === tomorrow) return 'Tomorrow';
  const parsed = new Date(`${value}T12:00:00Z`);
  return parsed.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function parseLocalDateTime(dateString, timeString, timezone) {
  if (!dateString || !timeString || timeString === 'now') return null;
  const match = String(timeString).match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const parts = String(dateString).split('-').map(Number);
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [year, month, day] = parts;
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const local = getLocalParts(guess, timezone);
    const asUTC = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second));
    guess = new Date(guess.getTime() + (wanted - asUTC));
  }
  return guess;
}

function getCountdownText(rideTime, rideDate, timezone) {
  if (!rideTime || rideTime === 'Flexible') return 'FLEXIBLE';
  const target = parseLocalDateTime(rideDate, rideTime, timezone);
  if (!target) return 'SCHEDULED';
  const diffMins = Math.round((target.getTime() - Date.now()) / 60000);
  if (diffMins <= 0 && diffMins > -30) return 'NOW';
  if (diffMins <= -30) return 'PAST';
  if (diffMins < 60) return `in ${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const minutes = diffMins % 60;
  return `in ${hours}h${minutes ? `${minutes}m` : ''}`;
}

function sortAndTagRides(rides, timezone) {
  const now = Date.now();
  return rides.map(ride => {
    const item = ride.dataValues ? { ...ride.dataValues } : { ...ride };
    const target = item.time && item.date ? parseLocalDateTime(item.date, item.time, timezone) : null;
    const targetMs = target ? target.getTime() : now + 86400000;
    const diffMins = Math.round((targetMs - now) / 60000);
    return {
      ...item,
      diffMins,
      isUrgent: diffMins >= -30 && diffMins <= 120,
      countdownStr: getCountdownText(item.time, item.date, timezone),
    };
  }).sort((a, b) => {
    if (a.isUrgent && !b.isUrgent) return -1;
    if (!a.isUrgent && b.isUrgent) return 1;
    return a.diffMins - b.diffMins;
  });
}

function normalizeLocation(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function locationTokens(value) {
  return normalizeLocation(value).split(/\s+/).filter(Boolean);
}

function isValidLocation(location) {
  if (!location) return false;
  const value = normalizeLocation(location);
  if (value.length < 2 || value.length > MAX_LOCATION_LENGTH) return false;
  if (value.startsWith('filter ') || value === 'filter') return false;
  if (value.startsWith('i want to offer') || value.startsWith('i want to give') || value.startsWith('offer ride') || value.startsWith('give ride')) return false;
  const invalid = [
    'need a ride', 'need ride', 'i need', 'want ride', 'want a ride', 'online', 'offline',
    'hello', 'hi', 'hey', 'thanks', 'where is', 'what is', 'who is', 'when did', 'tell me',
    'how are you', 'tomorrow', 'today', 'tonight', 'give ride', 'show requests', 'clear filters',
    'filter', 'filter juja', 'i want to offer ride', 'i want to give ride', 'offer ride', 'give ride', 'ride available', 'my rides', 'cancel ride', 'help', 'menu',
  ];
  return !invalid.some(x => value === x || value.includes(x) || value.startsWith(x));
}

function locationsEqual(a, b) {
  const x = normalizeLocation(a);
  const y = normalizeLocation(b);
  return Boolean(x && y && x === y);
}

function areLocationsNearby(a, b) {
  const x = normalizeLocation(a);
  const y = normalizeLocation(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const aTokens = locationTokens(x);
  const bTokens = new Set(locationTokens(y));
  const stopWords = new Set(['road', 'street', 'st', 'rd', 'avenue', 'ave', 'campus', 'area', 'town', 'city', 'the', 'near']);
  const meaningful = aTokens.filter(token => token.length >= 4 && !stopWords.has(token));
  return meaningful.some(token => bTokens.has(token));
}

function routeMatches(driverFrom, driverTo, rideFrom, rideTo) {
  const direct = areLocationsNearby(driverFrom, rideFrom) && areLocationsNearby(driverTo, rideTo);
  const reverse = areLocationsNearby(driverFrom, rideTo) && areLocationsNearby(driverTo, rideFrom);
  return direct || reverse;
}

function isPollutedRide(ride) {
  const from = String(ride?.from || '').trim();
  const to = String(ride?.to || '').trim();
  const date = String(ride?.date || '').trim();
  if (!isValidLocation(from) || !isValidLocation(to)) return true;
  if (from.length > MAX_LOCATION_LENGTH || to.length > MAX_LOCATION_LENGTH) return true;
  if (date && !parseExplicitDate(date)) return true;
  return false;
}

function isCommandPhrase(text) {
  const value = String(text || '').toLowerCase().trim();
  if (!value) return true;
  const commands = [
    'i want to give ride', 'give ride', 'want to give ride', 'ride available',
    'i want to offer ride', 'offer ride', 'i am driver', 'online', 'offline',
    'clear', 'next', 'more', 'hi', 'hello', 'hey', 'thanks', 'ok', 'okay',
  ];
  return commands.some(command => value === command || value.startsWith(`${command} `));
}

function parseRating(text) {
  const value = String(text || '').toLowerCase().trim();
  if (value.length > 40) return null;
  if (/^[1-5]$/.test(value)) return Number(value);
  const stars = value.match(/^([1-5])\s*stars?$/i);
  if (stars) return Number(stars[1]);
  if (value.includes('skip') || value.includes('need a ride')) return null;
  const number = value.match(/\b([1-5])\b/);
  return number ? Number(number[1]) : null;
}

function parseNameCommand(text) {
  const value = cleanText(text, MAX_NAME_LENGTH).trim();
  const match = value.match(/^(?:my name is|call me|name is)\s+(.+)$/i);
  return match ? cleanText(match[1], MAX_NAME_LENGTH) : null;
}

function getActiveChat(phone) {
  return activeChats.get(normalizePhone(phone));
}

function setActiveChat(phone, other, rideId) {
  const key = normalizePhone(phone);
  const otherKey = normalizePhone(other);
  if (!key || !otherKey) return;
  const record = { with: otherKey, rideId: Number(rideId), startedAt: Date.now() };
  activeChats.set(key, record);
  activeChats.set(otherKey, { with: key, rideId: Number(rideId), startedAt: record.startedAt });
}

function killChatFor(phone) {
  const key = normalizePhone(phone);
  if (!key) return;
  const chat = activeChats.get(key);
  activeChats.delete(key);
  if (chat?.with) activeChats.delete(normalizePhone(chat.with));
}

async function answerGeneralQuestion(text, region, fromDraft) {
  const greeting = getTimeGreeting(region.timezone);
  const lower = String(text || '').toLowerCase().trim();
  if (['hi', 'hello', 'hey', 'start', 'menu'].includes(lower)) {
    return `${greeting}! 👋 I'm Induu, your ride-sharing assistant.\n\n*How can I help you today?*\n• *Need a ride?* Say "Need a ride from Juja to Nairobi tomorrow at 5pm"\n• *Driving?* Say "ONLINE Juja" or "Offering ride from Juja to Nairobi"\n• Say *HELP* for all commands.`;
  }
  return `${greeting}! 👋 Tell me where you're going and when, or say *HELP* to see available commands.`;
}

async function getOpenRides() {
  try {
    const rides = await RideRequest.findAll({
      where: { status: 'OPEN' },
      order: [['createdAt', 'DESC']],
      limit: 50,
    });
    return rides.filter(ride => !isPollutedRide(ride));
  } catch (err) {
    logError('getOpenRides failed', err);
    return [];
  }
}

function filterRidesForDriver(rides, driverFrom, driverTo, date) {
  return rides.filter(ride => {
    if (isPollutedRide(ride)) return false;
    if (date && ride.date && ride.date !== date) return false;
    return routeMatches(driverFrom, driverTo, ride.from, ride.to);
  });
}

async function notifyMatchingDrivers(ride, region) {
  try {
    const drivers = await User.findAll({
      where: {
        isOnline: true,
        onlineUntil: { [Op.gt]: new Date() },
      },
    });

    let notifiedCount = 0;
    for (const driver of drivers) {
      if (driver.phone === ride.phone) continue;
      const matchesFrom = !driver.filterFrom || areLocationsNearby(driver.filterFrom, ride.from) || areLocationsNearby(driver.filterFrom, ride.to);
      const matchesTo = !driver.filterTo || areLocationsNearby(driver.filterTo, ride.to) || areLocationsNearby(driver.filterTo, ride.from);
      if (matchesFrom && matchesTo) {
        const jid = getJid(driver.phone);
        if (jid) {
          await sendWhatsAppMessage(
            jid,
            `*NEW MATCHING RIDE REQUEST*\nRide ID: ${ride.id}\n${ride.from} → ${ride.to}\n${toDisplayDate(ride.date, region.timezone)} • ${toDisplayTime(ride.time)}\nSeats: ${ride.seats}\n\nReply *TAKE ${ride.id}* or *${ride.id}* to accept this ride.`
          );
          notifiedCount++;
        }
      }
    }
    return notifiedCount;
  } catch (err) {
    logError('notifyMatchingDrivers failed', err);
    return 0;
  }
}

async function takeRide(phoneJid, driverPhoneRaw, rideId, region) {
  try {
    const driverPhone = canonicalPhone(driverPhoneRaw, phoneJid);
    if (!driverPhone) {
      await sendWhatsAppMessage(phoneJid, '⚠️ Unable to identify driver phone number.');
      return;
    }

    const existingRide = await RideRequest.findByPk(rideId);
    if (existingRide && existingRide.phone === driverPhone) {
      await sendWhatsAppMessage(phoneJid, '⚠️ You cannot accept your own ride request.');
      return;
    }

    const result = await claimRideSafely(rideId, driverPhone);
    
    if (!result || !result.success) {
      const errorMsg = result?.message || '⚠️ Could not accept this ride. It may have already been taken, cancelled, or does not exist.';
      await sendWhatsAppMessage(phoneJid, errorMsg);
      return;
    }

    const ride = result.ride;
    if (!ride) {
      await sendWhatsAppMessage(phoneJid, '⚠️ Could not locate ride details.');
      return;
    }

    setActiveChat(driverPhone, ride.phone, ride.id);
    const driverUser = await User.getOrCreate(driverPhone);
    const riderUser = await User.getOrCreate(ride.phone);
    const riderJid = getJid(ride.phone);

    await sendWhatsAppMessage(
      phoneJid,
      `*RIDE MATCHED!* 🎉\nYou accepted Ride ID ${ride.id}.\nRider: ${riderUser.name || 'Rider'} (${Number(riderUser.rating || 5).toFixed(1)}★)\n\nChat is connected! Any message you type now will be forwarded directly to the rider.\nSay *END RIDE* when completed.`
    );

    if (riderJid) {
      await sendWhatsAppMessage(
        riderJid,
        `*DRIVER FOUND!* 🎉\nDriver: ${driverUser.name || 'Driver'} (${Number(driverUser.rating || 5).toFixed(1)}★) accepted your Ride ID ${ride.id}.\n\nChat connected! Any message you type now will be sent to your driver.`
      );
    }
  } catch (err) {
    logError('takeRide failed', err);
    await sendWhatsAppMessage(phoneJid, '❌ An error occurred while accepting the ride. Please try again.');
  }
}

async function checkAndForwardChat(senderJid, text, senderPhone) {
  const activeChat = getActiveChat(senderPhone);
  if (!activeChat) return false;
  const recipientJid = getJid(activeChat.with);
  if (!recipientJid) return false;
  await sendWhatsAppMessage(recipientJid, `💬 ${text}`);
  return true;
}

async function endRideForUser(phoneJid, userPhone, region) {
  const activeChat = getActiveChat(userPhone);
  if (!activeChat) {
    await sendWhatsAppMessage(phoneJid, 'You have no active ongoing ride chat.');
    return;
  }
  const rideId = activeChat.rideId;
  const otherPhone = activeChat.with;
  killChatFor(userPhone);
  await completeRideSafely(rideId, userPhone);

  ratingSessions.set(normalizePhone(userPhone), { other: otherPhone, rideId, createdAt: Date.now() });
  ratingSessions.set(normalizePhone(otherPhone), { other: userPhone, rideId, createdAt: Date.now() });

  await sendWhatsAppMessage(phoneJid, `*RIDE COMPLETED!*\nChat closed.\n\nHow was your trip? Rate the other person from 1 to 5 stars (or type 'skip').`);
  const otherJid = getJid(otherPhone);
  if (otherJid) {
    await sendWhatsAppMessage(otherJid, `*RIDE COMPLETED!*\nChat closed.\n\nHow was your trip? Rate the other person from 1 to 5 stars (or type 'skip').`);
  }
}

async function cancelRideForUser(phoneJid, userPhone) {
  try {
    const activeChat = getActiveChat(userPhone);
    if (activeChat) {
      const otherJid = getJid(activeChat.with);
      killChatFor(userPhone);
      await cancelRideSafely(activeChat.rideId, userPhone);
      if (otherJid) await sendWhatsAppMessage(otherJid, `Ride ID ${activeChat.rideId} was cancelled.`);
      await sendWhatsAppMessage(phoneJid, `Ride ID ${activeChat.rideId} cancelled.`);
      return;
    }
    const openRides = await findUserOpenRequests(userPhone);
    if (!openRides.length) {
      await sendWhatsAppMessage(phoneJid, 'You have no open ride requests to cancel.');
      return;
    }
    for (const ride of openRides) {
      await cancelRideSafely(ride.id, userPhone);
    }
    await sendWhatsAppMessage(phoneJid, `Cancelled ${openRides.length} open ride request(s).`);
  } catch (err) {
    logError('cancelRideForUser failed', err);
    await sendWhatsAppMessage(phoneJid, 'Failed to cancel ride.');
  }
}

async function sendWhatsAppMessage(toJid, text) {
  if (!sock || !toJid) return false;
  const jid = getJid(toJid);
  if (!jid) return false;
  const body = cleanText(text);
  if (!body) return false;
  try {
    await sock.sendMessage(jid, { text: body });
    return true;
  } catch (err) {
    logError(`WhatsApp send failed [${jid}]`, err);
    return false;
  }
}

async function addRatingToUser(phone, newRating) {
  const key = normalizePhone(phone);
  const rating = Number(newRating);
  if (!key || ![1, 2, 3, 4, 5].includes(rating)) return 5;
  try {
    const user = await User.getOrCreate(key);
    const count = Math.max(0, Number(user.ratingCount || 0));
    const current = Number.isFinite(Number(user.rating)) ? Number(user.rating) : 5;
    user.rating = count === 0 ? rating : ((current * count) + rating) / (count + 1);
    user.ratingCount = count + 1;
    await user.save();
    return Number(user.rating || 5);
  } catch (err) {
    logError('Rating update failed', err);
    return 5;
  }
}

async function sendRidesList(toJid, rides, title = 'RIDES:', page = 0, timezone = 'America/Chicago') {
  const cleanRides = [];
  const seenIds = new Set();
  for (const ride of rides || []) {
    const item = ride.dataValues ? { ...ride.dataValues } : { ...ride };
    if (isPollutedRide(item)) continue;
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    cleanRides.push(item);
  }
  if (!cleanRides.length) {
    await sendWhatsAppMessage(toJid, 'No suitable rides are available right now.\nSay ONLINE to check again.');
    return;
  }
  const sorted = sortAndTagRides(cleanRides, timezone);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  let safePage = Number.isFinite(Number(page)) ? Number(page) : 0;
  if (safePage < 0) safePage = 0;
  if (safePage >= totalPages) safePage = 0;
  const start = safePage * PAGE_SIZE;
  const chunk = sorted.slice(start, start + PAGE_SIZE);
  let output = `*${sorted.length} rides* - P${safePage + 1}/${totalPages}\n`;
  output += 'Reply with the ride ID to take it.\n\n';
  for (const ride of chunk) {
    let rating = 5;
    let ratingCount = 0;
    let username = `Rider ${ride.id}`;
    try {
      const user = await User.getOrCreate(ride.phone);
      rating = Number(user.rating || 5);
      ratingCount = Math.max(0, Number(user.ratingCount || 0));
      if (user.name && String(user.name).trim().length >= 2) username = String(user.name).trim();
    } catch (_) {}
    const from = String(ride.from).trim().replace(/^./, c => c.toUpperCase());
    const to = String(ride.to).trim().replace(/^./, c => c.toUpperCase());
    const seats = clampInteger(ride.seats || ride.passengerCount, 1, MAX_SEATS, 1);
    output += `~ ${username} • ${rating.toFixed(1)}★ (${ratingCount})\n`;
    output += `${from} → ${to}\n`;
    output += `${toDisplayDate(ride.date, timezone)} • ${toDisplayTime(ride.time)} • ${ride.countdownStr}\n`;
    output += `${seats} ${seats === 1 ? 'seat' : 'seats'} • ID ${ride.id}\n\n`;
  }
  output += totalPages > 1 && safePage < totalPages - 1
    ? `NEXT for more | Take ${chunk[0].id}`
    : `Take ${chunk[0].id} or say ONLINE to refresh`;
  await sendWhatsAppMessage(toJid, output.trim());
  const session = getSession(toJid);
  session.ridesList = sorted;
  session.ridesPage = safePage;
  session.lastTitle = title;
}

const SYSTEM_PROMPT = `
You are Induu, an intelligent WhatsApp ride-sharing assistant.
You are a parser, not a conversational narrator. Return ONLY JSON.
The only model allowed for this parser is openai/gpt-oss-20b.

Current context:
- Country: {COUNTRY}
- Timezone: {TIMEZONE}
- Local date: {TODAY_DATE}
- Local date/time: {TODAY_INFO}
- Existing draft: {CONTEXT_DRAFT}
- Last intent: {LAST_INTENT}

CLASSIFY:
- rider: user wants someone to drive them.
- driver: user is offering/driving a vehicle.
- command: operational command.
- chat: greeting, question, thanks, or unrelated conversation.

COMMANDS:
ONLINE, OFFLINE, SHOW_REQUESTS, TAKE, FILTER, CLEAR_FILTERS, NEXT, END_RIDE, CANCEL_RIDE, MY_RIDES, HELP, PROFILE.

EXTRACTION RULES:
1. Preserve information from the existing draft.
2. Never invent a location.
3. 'tomorrow' means the next local calendar day.
4. A weekday means the next occurrence of that weekday, not a past day.
5. 'day after tomorrow' means two local calendar days ahead.
6. '5pm', '5 pm', '17:00' become 17:00.
7. 'for 2 people', '2 passengers', 'two of us' becomes seats=2.
8. If the user says 'need a ride tomorrow', date MUST be tomorrow even if location/time are missing.
9. If the user gives date/time in a later message, preserve earlier draft fields.
10. Never replace a known date with today merely because time was supplied later.
11. If date is omitted, return null. The application decides whether today's date is appropriate.
12. If time is omitted, return null. Do not invent a time.
13. Locations should be short place names, campuses, estates, towns, streets, airports, stations, etc.
14. Do not classify 'I need a ride' as chat.
15. 'I can take someone from A to B' is driver.
16. 'I am going from A to B and can take 2' is driver.
17. A numeric-only message is handled by the application as a ride ID.
18. General questions are chat unless clearly part of a ride request.

Return exactly:
{
  "role":"rider|driver|command|chat",
  "command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|FILTER|CLEAR_FILTERS|NEXT|END_RIDE|CANCEL_RIDE|MY_RIDES|HELP|PROFILE|null",
  "filter":string|null,
  "takeId":number|null,
  "from":string|null,
  "to":string|null,
  "date":"YYYY-MM-DD"|null,
  "time":"HH:MM"|null,
  "seats":number|null,
  "name":string|null
}`;

function validateAIResult(data) {
  if (!data || typeof data !== 'object') return { role: 'chat' };
  const allowedRoles = new Set(['rider', 'driver', 'command', 'chat']);
  const allowedCommands = new Set([
    'ONLINE', 'OFFLINE', 'SHOW_REQUESTS', 'TAKE', 'FILTER', 'CLEAR_FILTERS',
    'NEXT', 'END_RIDE', 'CANCEL_RIDE', 'MY_RIDES', 'HELP', 'PROFILE',
  ]);
  return {
    role: allowedRoles.has(data.role) ? data.role : 'chat',
    command: allowedCommands.has(data.command) ? data.command : null,
    filter: typeof data.filter === 'string' ? cleanText(data.filter, MAX_LOCATION_LENGTH) : null,
    takeId: clampInteger(data.takeId, 1, Number.MAX_SAFE_INTEGER, null),
    from: typeof data.from === 'string' ? cleanText(data.from, MAX_LOCATION_LENGTH) : null,
    to: typeof data.to === 'string' ? cleanText(data.to, MAX_LOCATION_LENGTH) : null,
    date: typeof data.date === 'string' ? data.date : null,
    time: typeof data.time === 'string' ? data.time : null,
    seats: clampInteger(data.seats, 1, MAX_SEATS, null),
    name: typeof data.name === 'string' ? cleanText(data.name, MAX_NAME_LENGTH) : null,
  };
}

function mergeDraft(draft, ai, region) {
  const merged = {
    ...draft,
    role: ai.role === 'rider' || ai.role === 'driver' ? ai.role : draft.role,
  };
  if (ai.from && isValidLocation(ai.from)) merged.from = ai.from;
  if (ai.to && isValidLocation(ai.to)) merged.to = ai.to;
  if (ai.seats) merged.seats = clampInteger(ai.seats, 1, MAX_SEATS, draft.seats || 1);
  if (ai.date) {
    const date = getRealDate(ai.date, region.timezone);
    if (date) merged.date = date;
  }
  if (ai.time) {
    const time = getRealTime(ai.time, region.timezone);
    if (time) merged.time = time;
  }
  if (ai.name) merged.name = ai.name;
  return merged;
}

async function parseWithAI(message, region, contextDraft = {}, lastIntent = null) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    log('warn', 'GROQ_API_KEY missing');
    return { role: 'chat' };
  }
  const todayDate = getLocalDateString(new Date(), region.timezone);
  const local = getLocalParts(new Date(), region.timezone);
  const todayInfo = `${local.weekday} ${todayDate} ${local.hour}:${local.minute}`;
  const prompt = SYSTEM_PROMPT
    .replace('{COUNTRY}', region.country)
    .replace('{TIMEZONE}', region.timezone)
    .replace('{TODAY_INFO}', todayInfo)
    .replace('{TODAY_DATE}', todayDate)
    .replace('{CONTEXT_DRAFT}', JSON.stringify(contextDraft || {}))
    .replace('{LAST_INTENT}', String(lastIntent || 'none'));
  try {
    const response = await axios.post(GROQ_URL, {
      model: GROQ_MODELS[0],
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: cleanText(message) },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
      max_tokens: 500,
    }, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    });
    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) return { role: 'chat' };
    const data = validateAIResult(JSON.parse(content));
    if (data.from && !isValidLocation(data.from)) data.from = null;
    if (data.to && !isValidLocation(data.to)) data.to = null;
    if (data.date) data.date = getRealDate(data.date, region.timezone);
    if (data.time) data.time = getRealTime(data.time, region.timezone);
    return data;
  } catch (err) {
    logError('Groq parser failed', err);
    return deterministicIntent(message, region, contextDraft);
  }
}

function deterministicIntent(text, region, draft = {}) {
  const value = String(text || '').trim();
  const lower = value.toLowerCase();
  const result = { role: 'chat', command: null, filter: null, takeId: null, from: null, to: null, date: null, time: null, seats: null, name: null };
  const direct = parseDirectCommand(value);
  if (direct) return { ...result, ...direct, role: 'command' };
  if (/^\d+$/.test(lower)) return { ...result, role: 'command', command: 'TAKE', takeId: Number(lower) };
  const wantsRide = /\b(need|want|looking for|book|find|request)\b.*\b(ride|lift|pickup|car)\b/i.test(value) || /\bneed a ride\b/i.test(value);
  const offersRide = /\b(can give|give|offer|driving|drive|taking|take someone|have space)\b.*\b(ride|lift|passenger|people|from)\b/i.test(value);
  const route = value.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:at|on|tomorrow|today|for)\b|$)/i);
  if (route) {
    result.from = cleanText(route[1], MAX_LOCATION_LENGTH);
    result.to = cleanText(route[2], MAX_LOCATION_LENGTH);
  }
  if (wantsRide) result.role = 'rider';
  else if (offersRide) result.role = 'driver';
  else if (draft.role) result.role = draft.role;
  if (/\btomorrow\b/i.test(value)) result.date = localDatePlusDays(1, region.timezone);
  else if (/\bday after tomorrow\b/i.test(value)) result.date = localDatePlusDays(2, region.timezone);
  else if (/\btoday\b/i.test(value)) result.date = getLocalDateString(new Date(), region.timezone);
  const timeMatch = value.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i);
  if (timeMatch) result.time = getRealTime(timeMatch[0], region.timezone);
  const seatsMatch = value.match(/\b(\d+)\s*(?:people|person|passengers|pax|seats?)\b/i);
  if (seatsMatch) result.seats = clampInteger(seatsMatch[1], 1, MAX_SEATS, null);
  return result;
}

function parseDirectCommand(text) {
  const value = String(text || '').trim().toLowerCase();
  if (value === 'online') return { command: 'ONLINE', filter: null };
  if (value.startsWith('online ')) return { command: 'ONLINE', filter: value.slice(7).trim() || null };
  if (value === 'offline') return { command: 'OFFLINE' };
  if (['next', 'more', 'next page'].includes(value)) return { command: 'NEXT' };
  if (['clear', 'clear filters', 'clear filter'].includes(value)) return { command: 'CLEAR_FILTERS' };
  if (['show requests', 'show rides', 'rides', 'available rides'].includes(value)) return { command: 'SHOW_REQUESTS' };
  if (['end ride', 'end trip', 'complete', 'complete trip', 'done', 'finish', 'end', 'end this ride'].includes(value)) return { command: 'END_RIDE' };
  if (['cancel ride', 'cancel request', 'cancel my ride'].includes(value)) return { command: 'CANCEL_RIDE' };
  if (['my rides', 'my requests', 'my trips'].includes(value)) return { command: 'MY_RIDES' };
  if (value === 'help' || value === 'menu') return { command: 'HELP' };
  if (value === 'profile' || value === 'my profile') return { command: 'PROFILE' };
  const filter = value.match(/^filter\s+(.+)$/i);
  if (filter) return { command: 'FILTER', filter: filter[1].trim() };
  const take = value.match(/^(?:take|accept|book)\s+(\d+)$/i);
  if (take) return { command: 'TAKE', takeId: Number(take[1]) };
  return null;
}

async function handleDirectCommand(cmd, phoneJid, userPhoneKey, region) {
  if (!cmd?.command) return;
  const command = cmd.command;
  if (command === 'NEXT') {
    const session = getSession(userPhoneKey);
    if (!session.ridesList?.length) {
      await sendWhatsAppMessage(phoneJid, 'No active ride list. Say ONLINE to see available rides.');
      return;
    }
    const totalPages = Math.max(1, Math.ceil(session.ridesList.length / PAGE_SIZE));
    let nextPage = (session.ridesPage || 0) + 1;
    if (nextPage >= totalPages) nextPage = 0;
    await sendRidesList(phoneJid, session.ridesList, session.lastTitle, nextPage, region.timezone);
    return;
  }
  if (command === 'OFFLINE') {
    const user = await User.getOrCreate(userPhoneKey);
    await user.setOffline();
    const session = getSession(userPhoneKey);
    session.draft = {};
    await sendWhatsAppMessage(phoneJid, `You are offline. ${getTimeGreeting(region.timezone)}!`);
    return;
  }
  if (command === 'ONLINE') {
    const user = await User.getOrCreate(userPhoneKey);
    let filter = null;
    let location = user.location || region.defaultCity;
    if (cmd.filter && isValidLocation(cmd.filter)) {
      filter = cmd.filter.replace(/^in\s+/i, '').trim();
      location = filter;
    }
    await user.setOnline(location, DRIVER_ONLINE_HOURS);
    user.filterFrom = filter;
    user.onlineDate = getLocalDateString(new Date(), region.timezone);
    await user.save();
    const rides = await getOpenRides();
    const filtered = filter ? rides.filter(ride => !isPollutedRide(ride) && (areLocationsNearby(filter, ride.from) || areLocationsNearby(filter, ride.to))) : rides.filter(ride => !isPollutedRide(ride));
    await sendWhatsAppMessage(phoneJid, filter ? `ONLINE near ${filter}. Rating: ${Number(user.rating || 5).toFixed(1)}★` : `ONLINE. Rating: ${Number(user.rating || 5).toFixed(1)}★`);
    await sendRidesList(phoneJid, filtered, filter ? `${filtered.length} RIDES NEAR ${filter.toUpperCase()}:` : `${filtered.length} OPEN RIDES:`, 0, region.timezone);
    return;
  }
  if (command === 'CLEAR_FILTERS') {
    const user = await User.getOrCreate(userPhoneKey);
    user.filterFrom = null;
    user.filterTo = null;
    await user.save();
    const rides = await getOpenRides();
    await sendRidesList(phoneJid, rides, `${rides.length} OPEN RIDES:`, 0, region.timezone);
    return;
  }
  if (command === 'FILTER') {
    const filter = cleanText(cmd.filter, MAX_LOCATION_LENGTH);
    if (!isValidLocation(filter)) {
      await sendWhatsAppMessage(phoneJid, 'Please provide a valid location. Example: FILTER Nairobi');
      return;
    }
    const user = await User.getOrCreate(userPhoneKey);
    user.filterFrom = filter;
    await user.save();
    const rides = await getOpenRides();
    const filtered = rides.filter(ride => !isPollutedRide(ride) && (areLocationsNearby(filter, ride.from) || areLocationsNearby(filter, ride.to)));
    await sendRidesList(phoneJid, filtered, `${filtered.length} RIDES NEAR ${filter.toUpperCase()}:`, 0, region.timezone);
    return;
  }
  if (command === 'SHOW_REQUESTS') {
    const rides = await getOpenRides();
    await sendRidesList(phoneJid, rides, `${rides.length} OPEN RIDES:`, 0, region.timezone);
    return;
  }
  if (command === 'TAKE') {
    await takeRide(phoneJid, userPhoneKey, Number(cmd.takeId), region);
    return;
  }
  if (command === 'END_RIDE') {
    await endRideForUser(phoneJid, userPhoneKey, region);
    return;
  }
  if (command === 'CANCEL_RIDE') {
    await cancelRideForUser(phoneJid, userPhoneKey);
    return;
  }
  if (command === 'MY_RIDES') {
    const requests = await RideRequest.findAll({ where: { phone: userPhoneKey }, order: [['createdAt', 'DESC']], limit: 10 });
    if (!requests.length) {
      await sendWhatsAppMessage(phoneJid, 'You have no recent ride requests.');
      return;
    }
    let output = '*Your recent rides*\n\n';
    for (const ride of requests) {
      output += `ID ${ride.id} • ${ride.status}\n${ride.from} → ${ride.to}\n${toDisplayDate(ride.date, region.timezone)} • ${toDisplayTime(ride.time)}\n\n`;
    }
    await sendWhatsAppMessage(phoneJid, output.trim());
    return;
  }
  if (command === 'HELP') {
    await sendWhatsAppMessage(phoneJid,
      '*Induu commands*\n\nNeed a ride\nGive a ride from A to B\nONLINE [location]\nOFFLINE\nNEXT\nTAKE 123\nCANCEL RIDE\nMY RIDES\nEND RIDE\nPROFILE\nCLEAR\nHELP\n\nYou can also speak naturally, e.g. “Need a ride tomorrow from Juja to Nairobi at 5pm for 2 people.”');
    return;
  }
  if (command === 'PROFILE') {
    const user = await User.getOrCreate(userPhoneKey);
    const status = user.isOnline && user.onlineUntil && new Date(user.onlineUntil) > new Date() ? 'ONLINE' : 'OFFLINE';
    await sendWhatsAppMessage(phoneJid,
      `*Your profile*\nName: ${user.name || 'Not set'}\nRating: ${Number(user.rating || 5).toFixed(1)}★ (${user.ratingCount || 0})\nStatus: ${status}\nArea: ${user.location || 'Not set'}\n\nTo change your name: MY NAME IS Your Name`);
  }
}

async function handleNameMessage(phoneJid, phone, text) {
  const name = parseNameCommand(text);
  if (!name) return false;
  const user = await User.getOrCreate(phone);
  user.name = name;
  await user.save();
  await sendWhatsAppMessage(phoneJid, `Thanks. I'll use “${name}” on your Induu profile.`);
  return true;
}

async function createRideFromDraft(phoneJid, phone, draft, region) {
  if (!draft.from || !draft.to) return false;
  if (locationsEqual(draft.from, draft.to)) {
    await sendWhatsAppMessage(phoneJid, `From and to cannot be the same (${draft.from}).`);
    return false;
  }
  const date = draft.date || getLocalDateString(new Date(), region.timezone);
  const time = draft.time || null;
  if (!time) return false;
  const seats = clampInteger(draft.seats, 1, MAX_SEATS, 1);
  const ride = await createRideSafely(phone, {
    from: draft.from,
    to: draft.to,
    time,
    date,
    seats,
  });
  const displayDate = toDisplayDate(date, region.timezone);
  await sendWhatsAppMessage(phoneJid,
    `RIDE ${ride.id} CREATED\n${ride.from} → ${ride.to}\n${displayDate} • ${toDisplayTime(ride.time)} • ${seats} ${seats === 1 ? 'seat' : 'seats'}\nAlerting suitable drivers...`);
  const notified = await notifyMatchingDrivers(ride, region);
  if (!notified) await sendWhatsAppMessage(phoneJid, 'No suitable online drivers were found yet. Your request remains open.');
  else await sendWhatsAppMessage(phoneJid, `${notified} online driver${notified === 1 ? '' : 's'} notified.`);
  clearSession(phone);
  return true;
}

async function continueDraft(phoneJid, phone, rawText, region, session) {
  const draft = session.draft || {};
  if (!draft.role) return false;
  if (!draft.from && isValidLocation(rawText) && !getRealTime(rawText, region.timezone)) {
    draft.from = rawText;
    session.draft = draft;
    await sendWhatsAppMessage(phoneJid, `Got it, from ${rawText}. Where to? Example: ${region.exampleDest}`);
    return true;
  }
  if (draft.from && !draft.to && isValidLocation(rawText) && !getRealTime(rawText, region.timezone)) {
    if (locationsEqual(draft.from, rawText)) {
      await sendWhatsAppMessage(phoneJid, `From and to cannot be the same (${draft.from}). Where to?`);
      return true;
    }
    draft.to = rawText;
    session.draft = draft;
    if (draft.date) await sendWhatsAppMessage(phoneJid, `Got it, ${draft.from} → ${draft.to} on ${toDisplayDate(draft.date, region.timezone)}. What time?`);
    else await sendWhatsAppMessage(phoneJid, `Got it, ${draft.from} → ${draft.to}. What date and time? Example: tomorrow at 5pm`);
    return true;
  }
  if (draft.from && draft.to) {
    const parsedTime = getRealTime(rawText, region.timezone);
    const parsedDate = getRealDate(rawText, region.timezone);
    const seatsMatch = rawText.match(/\b(\d+)\s*(?:people|person|passengers|pax|seats?)\b/i);
    if (parsedDate) draft.date = parsedDate;
    if (parsedTime) draft.time = parsedTime;
    if (seatsMatch) draft.seats = clampInteger(seatsMatch[1], 1, MAX_SEATS, draft.seats || 1);
    if (draft.time && draft.date) {
      await createRideFromDraft(phoneJid, phone, draft, region);
      return true;
    }
    session.draft = draft;
    if (!draft.date) {
      await sendWhatsAppMessage(phoneJid, 'What date? You can say today, tomorrow, or Friday.');
      return true;
    }
    if (!draft.time) {
      await sendWhatsAppMessage(phoneJid, `What time on ${toDisplayDate(draft.date, region.timezone)}? Example: 5pm`);
      return true;
    }
  }
  return false;
}

async function handleRideLogic(phoneJid, text, realPhone) {
  const rawText = cleanText(text);
  if (!rawText) return;
  const lowerText = rawText.toLowerCase().trim();
  const phone = canonicalPhone(realPhone, phoneJid);
  if (!phone) return;
  const region = detectUserRegion(phone);
  const session = getSession(phone);
  try {
    if (await handleNameMessage(phoneJid, phone, rawText)) return;

    const ratingSession = ratingSessions.get(phone);
    if (ratingSession) {
      const looksLikeNewRide = /\bneed\s+(?:a\s+)?ride\b/i.test(lowerText) ||
        (/\bfrom\b/.test(lowerText) && /\bto\b/.test(lowerText));
      if (!looksLikeNewRide && rawText.length <= 40) {
        const rating = parseRating(lowerText);
        if (rating) {
          const newAverage = await addRatingToUser(ratingSession.other, rating);
          ratingSessions.delete(phone);
          ratingSessions.delete(normalizePhone(ratingSession.other));
          await sendWhatsAppMessage(phoneJid, `Rating saved: ${rating}★ for trip ${ratingSession.rideId}. Their new average is ${newAverage.toFixed(1)}★.`);
          return;
        }
        if (lowerText === 'skip' || lowerText === 'no') {
          ratingSessions.delete(phone);
          await sendWhatsAppMessage(phoneJid, 'Rating skipped. Need another ride? Say: Need a ride.');
          return;
        }
      } else {
        ratingSessions.delete(phone);
      }
    }

    const direct = parseDirectCommand(rawText);
    if (direct) {
      await handleDirectCommand(direct, phoneJid, phone, region);
      return;
    }

    if (/^\d+$/.test(lowerText)) {
      await takeRide(phoneJid, phone, Number(lowerText), region);
      return;
    }

    const activeChat = getActiveChat(phone);
    if (activeChat) {
      const controlWords = ['end ride', 'end trip', 'complete', 'done', 'finish', 'cancel ride', 'need a ride', 'online', 'offline'];
      const isControl = controlWords.some(word => lowerText === word || lowerText.startsWith(`${word} `));
      if (!isControl) {
        if (await checkAndForwardChat(phoneJid, rawText, phone)) return;
      }
    }

    if (session.draft?.role) {
      const continued = await continueDraft(phoneJid, phone, rawText, region, session);
      if (continued) return;
    }

    const ai = await parseWithAI(rawText, region, session.draft || {}, session.lastIntent);
    session.lastIntent = ai.role;

    if (ai.role === 'chat') {
      const reply = await answerGeneralQuestion(rawText, region, session.draft?.from);
      await sendWhatsAppMessage(phoneJid, reply || "I'm Induu. Tell me where you're going and when, and I'll help find a ride.");
      return;
    }

    if (ai.role === 'command' || ai.command) {
      await handleDirectCommand({ command: ai.command, filter: ai.filter, takeId: ai.takeId }, phoneJid, phone, region);
      return;
    }

    if (ai.role === 'driver') {
      const draft = mergeDraft(session.draft || {}, ai, region);
      draft.role = 'driver';
      if (!draft.from) {
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, `Where are you driving from? Example: ${region.examplePlaces}`);
        return;
      }
      if (!draft.to) {
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, `Where are you driving to? Example: ${region.exampleDest}`);
        return;
      }
      if (locationsEqual(draft.from, draft.to)) {
        draft.to = null;
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, `From and to cannot be the same (${draft.from}). Where are you driving to?`);
        return;
      }
      const user = await User.getOrCreate(phone);
      await user.setOnline(draft.from, DRIVER_ONLINE_HOURS);
      user.filterFrom = draft.from;
      user.filterTo = draft.to;
      user.onlineDate = draft.date || getLocalDateString(new Date(), region.timezone);
      await user.save();
      const rides = await getOpenRides();
      const matching = filterRidesForDriver(rides, draft.from, draft.to, draft.date || null);
      await sendWhatsAppMessage(phoneJid,
        `You're ONLINE for ${draft.from} → ${draft.to}. ${matching.length} matching ride${matching.length === 1 ? '' : 's'} available.`);
      if (matching.length) await sendRidesList(phoneJid, matching, 'MATCHING RIDES:', 0, region.timezone);
      else await sendWhatsAppMessage(phoneJid, 'No route-matching requests right now. I will keep you online for the next 2 hours.');
      clearSession(phone);
      return;
    }

    if (ai.role === 'rider') {
      const draft = mergeDraft(session.draft || {}, ai, region);
      draft.role = 'rider';
      const lower = lowerText;
      if (/^need\s+(?:a\s+)?ride(?:\s+please)?$/i.test(lower)) {
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, `Where are you riding from? Example: ${region.examplePlaces}`);
        return;
      }
      if (!draft.from) {
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, `Where are you riding from? Example: ${region.examplePlaces}`);
        return;
      }
      if (!draft.to) {
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, `Where are you riding to? Example: ${region.exampleDest}`);
        return;
      }
      if (!draft.date) {
        draft.date = getRealDate(rawText, region.timezone) || null;
      }
      if (!draft.time) {
        draft.time = getRealTime(rawText, region.timezone) || null;
      }
      if (!draft.date) {
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, 'What date? Say today, tomorrow, or a weekday such as Friday.');
        return;
      }
      if (!draft.time) {
        session.draft = draft;
        await sendWhatsAppMessage(phoneJid, `What time on ${toDisplayDate(draft.date, region.timezone)}? Example: 5pm or 17:00`);
        return;
      }
      draft.seats = clampInteger(draft.seats, 1, MAX_SEATS, 1);
      await createRideFromDraft(phoneJid, phone, draft, region);
      return;
    }

    const reply = await answerGeneralQuestion(rawText, region, session.draft?.from);
    await sendWhatsAppMessage(phoneJid, reply || "Tell me something like: Need a ride tomorrow from Juja to Nairobi at 5pm for 2 people.");
  } catch (err) {
    logError(`Error in handleRideLogic [${phone}]`, err);
    await sendWhatsAppMessage(phoneJid, 'Sorry, something went wrong while processing that. Please try again.');
  }
}

function extractMessageText(message) {
  if (!message) return '';
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.buttonsResponseMessage) return message.buttonsResponseMessage.selectedButtonId || message.buttonsResponseMessage.selectedDisplayText || '';
  if (message.templateButtonReplyMessage) return message.templateButtonReplyMessage.selectedId || message.templateButtonReplyMessage.selectedDisplayText || '';
  if (message.listResponseMessage) return message.listResponseMessage.singleSelectReply?.selectedRowId || message.listResponseMessage.title || '';
  return '';
}

function registerMessageHandler(socket) {
  if (!socket) return;
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages || []) {
      try {
        if (!msg?.message || msg.key?.fromMe) continue;
        const remoteJid = msg.key?.remoteJid || '';
        if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.includes('@g.us')) continue;
        if (rememberMessage(msg.key?.id)) continue;
        const text = extractMessageText(msg.message);
        if (!text) continue;
        let realPhone = remoteJid;
        if (remoteJid.includes('@lid')) {
          if (msg.key?.participant && !msg.key.participant.includes('@lid')) realPhone = msg.key.participant;
          else if (msg.key?.remoteJidAlt && !msg.key.remoteJidAlt.includes('@lid')) realPhone = msg.key.remoteJidAlt;
        }
        const phone = canonicalPhone(realPhone, remoteJid);
        if (!phone) continue;
        log('info', `MSG ${phone}`, { text: cleanText(text, 300) });
        await queueUserMessage(phone, () => handleRideLogic(remoteJid, text, phone));
      } catch (err) {
        if (String(err?.message || '').includes('Bad MAC')) continue;
        logError('Message handling error', err);
      }
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer || shuttingDown) return;
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt - 1, 5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWhatsApp().catch(err => logError('Reconnect failed', err));
  }, delay);
  reconnectTimer.unref?.();
  log('warn', `WhatsApp reconnect scheduled in ${delay}ms`, { attempt: reconnectAttempt });
}

async function startWhatsApp() {
  if (startingWhatsApp || shuttingDown) return;
  startingWhatsApp = true;
  try {
    fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    const newSocket = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Induu Universal', 'Chrome', '1.0.0'],
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });
    sock = newSocket;
    newSocket.ev.on('creds.update', saveCreds);
    newSocket.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrLast = qr;
        log('info', 'WhatsApp QR available');
      }
      if (connection === 'open') {
        log('info', 'WhatsApp connected');
        qrLast = null;
        reconnectAttempt = 0;
        startingWhatsApp = false;
        return;
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (sock === newSocket) sock = null;
        qrLast = null;
        startingWhatsApp = false;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        if (loggedOut) {
          try {
            if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true });
          } catch (err) {
            logError('Auth cleanup failed', err);
          }
          reconnectAttempt = 0;
        }
        if (!shuttingDown) scheduleReconnect();
      }
    });
    registerMessageHandler(newSocket);
  } catch (err) {
    startingWhatsApp = false;
    sock = null;
    logError('WhatsApp startup error', err);
    if (!shuttingDown) scheduleReconnect();
  }
}

function cleanupMemory() {
  const now = Date.now();
  for (const [phone, session] of userSessions) {
    if (now - session.lastUpdated > SESSION_TTL_MS) userSessions.delete(phone);
  }
  for (const [phone, rating] of ratingSessions) {
    if (now - (rating.createdAt || now) > SESSION_TTL_MS) ratingSessions.delete(phone);
  }
  for (const [key, timestamp] of notificationLocks) {
    if (now - timestamp > 60000) notificationLocks.delete(key);
  }
}

async function maintenance() {
  try {
    cleanupMemory();
    await cleanupDatabase();
    await User.update(
      { isOnline: false, onlineUntil: null },
      { where: { isOnline: true, onlineUntil: { [Op.lte]: new Date() } } },
    );
  } catch (err) {
    logError('Maintenance failed', err);
  }
}

function adminOnly(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).send('Admin API disabled: ADMIN_SECRET is not configured');
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).send('Unauthorized');
  next();
}

app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    service: 'Induu',
    version: '2.0',
    database: dbReady,
    whatsapp: Boolean(sock),
    model: GROQ_MODELS[0],
    uptime: Math.round(process.uptime()),
    sessions: userSessions.size,
    activeChats: activeChats.size / 2,
  });
});

app.get('/', (req, res) => {
  res.send('Induu LIVE - Intelligent Student Ride Sharing');
});

app.get('/health', adminOnly, async (req, res) => {
  let database = false;
  try { await sequelize.authenticate(); database = true; } catch (_) {}
  res.json({ ok: database && Boolean(sock), database, whatsapp: Boolean(sock), model: GROQ_MODELS[0] });
});

app.get('/qr', adminOnly, (req, res) => {
  if (!qrLast) return res.send('<h1>Connected or QR is not currently available.</h1>');
  res.type('text/plain').send(qrLast);
});

app.get('/stats', adminOnly, async (req, res) => {
  try {
    const [users, open, taken, completed] = await Promise.all([
      User.count(),
      RideRequest.count({ where: { status: 'OPEN' } }),
      RideRequest.count({ where: { status: 'TAKEN' } }),
      RideRequest.count({ where: { status: 'COMPLETED' } }),
    ]);
    res.json({ users, rides: { open, taken, completed }, runtime: { sessions: userSessions.size, activeChats: activeChats.size / 2 } });
  } catch (err) {
    logError('stats endpoint failed', err);
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

app.get('/ratings', adminOnly, async (req, res) => {
  try {
    const users = await User.findAll({ order: [['rating', 'DESC']] });
    res.json(users.map(user => ({
      phone: normalizePhone(user.phone),
      name: user.name || null,
      rating: Number(user.rating || 5),
      count: Math.max(0, Number(user.ratingCount || 0)),
    })));
  } catch (err) {
    logError('ratings endpoint failed', err);
    res.status(500).json({ error: 'Failed to load ratings.' });
  }
});

app.post('/clearall', adminOnly, async (req, res) => {
  try {
    await RideRequest.destroy({ where: {} });
    await RideOffer.destroy({ where: {} });
    activeChats.clear();
    userSessions.clear();
    ratingSessions.clear();
    endingLocks.clear();
    notificationLocks.clear();
    res.json({ ok: true, message: 'All rides deleted and runtime state cleared.' });
  } catch (err) {
    logError('clearall failed', err);
    res.status(500).json({ ok: false, error: 'Failed to clear data.' });
  }
});

app.post('/cleardb', adminOnly, async (req, res) => {
  try {
    const confirmation = req.get('x-confirm-db-wipe');
    if (confirmation !== 'WIPE_DATABASE') return res.status(400).send('Database wipe blocked. Set X-Confirm-DB-Wipe: WIPE_DATABASE.');
    await sequelize.sync({ force: true });
    activeChats.clear();
    userSessions.clear();
    ratingSessions.clear();
    endingLocks.clear();
    await initDatabase();
    res.json({ ok: true, message: 'Full database wiped and recreated.' });
  } catch (err) {
    logError('cleardb failed', err);
    res.status(500).json({ ok: false, error: 'Failed to wipe database.' });
  }
});

app.use((err, req, res, next) => {
  logError('Express error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

async function bootstrap() {
  try {
    await initDatabase();
    dbReady = true;
    await cleanupDatabase();
    server = app.listen(PORT, () => log('info', `Induu running on ${PORT}`));
    await startWhatsApp();
  } catch (err) {
    dbReady = false;
    logError('Bootstrap failed', err);
    process.exitCode = 1;
  }
}

const maintenanceTimer = setInterval(maintenance, EXPIRY_INTERVAL_MS);
maintenanceTimer.unref?.();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('warn', `${signal} received. Shutting down...`);
  clearInterval(maintenanceTimer);
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  try { if (sock) { sock.end(undefined); sock = null; } } catch (_) {}
  try { await sequelize.close(); } catch (_) {}
  if (server) {
    await new Promise(resolve => server.close(() => resolve()));
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', reason => logError('Unhandled promise rejection', reason));
process.on('uncaughtException', err => {
  logError('Uncaught exception', err);
  if (!shuttingDown) setTimeout(() => shutdown('UNCAUGHT_EXCEPTION'), 1000).unref?.();
});

bootstrap();

module.exports = {
  app,
  normalizePhone,
  getRealDate,
  getRealTime,
  parseLocalDateTime,
  routeMatches,
  isValidLocation,
  deterministicIntent,
};
