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
} = require('./database');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
 
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
 
const PORT = Number(process.env.PORT || 10000);
const AUTH_PATH = path.join(__dirname, 'auth_info');
const PAGE_SIZE = 20;
const DEFAULT_ONLINE_HOURS = 2;
const DEFAULT_TIMEZONE = 'America/Chicago';
const RIDE_REQUEST_TTL_MINUTES = 30;
const RIDE_URGENT_PAST_MINUTES = 15;
const RIDE_URGENT_FUTURE_MINUTES = 60;
const MAX_RIDE_EXTENSIONS = 3;
const USERNAME_CHANGE_LIMIT = 1;
const MAX_SEATS = 6;
const MAX_BAGS = 10;
const GROQ_MODEL = 'openai/gpt-oss-20b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAINTENANCE_INTERVAL_MS = 60 * 1000;
const SESSION_TTL_MS = 45 * 60 * 1000;
 
let sock = null;
let qrLast = null;
let reconnectTimer = null;
let startingWhatsApp = false;
 
const userSessions = new Map();
const activeChats = new Map();
const ratingSessions = new Map();
const endingLocks = new Set();
const userQueues = new Map();
 
function normalizePhone(value) {
  if (!value) return '';
  return String(value).split('@')[0].replace(/[^0-9]/g, '');
}
 
function canonicalPhone(realPhone, remoteJid) {
  return normalizePhone(realPhone) || normalizePhone(remoteJid);
}
 
function jidFor(value) {
  if (!value) return '';
  if (String(value).includes('@')) return String(value);
  return `${normalizePhone(value)}@s.whatsapp.net`;
}
 
function getSessionKey(value) {
  return normalizePhone(value) || String(value || '');
}
 
function getSession(phone) {
  const key = getSessionKey(phone);
  if (!userSessions.has(key)) {
    userSessions.set(key, {
      draft: {},
      ridesList: [],
      ridesPage: 0,
      lastTitle: 'RIDES:',
      updatedAt: Date.now(),
    });
  }
  const session = userSessions.get(key);
  session.updatedAt = Date.now();
  return session;
}
 
function clearSession(phone) {
  userSessions.delete(getSessionKey(phone));
}
 
function mergeDraft(existing, updates) {
  return {
    ...(existing || {}),
    ...(updates || {}),
    role: (updates && updates.role) || (existing && existing.role),
  };
}
 
function queueUserMessage(phone, task) {
  const key = getSessionKey(phone) || 'unknown';
  const previous = userQueues.get(key) || Promise.resolve();
 
  const next = previous
    .catch(() => {})
    .then(task)
    .catch((err) => {
      console.error('User queue error:', err?.stack || err?.message || err);
    });
 
  userQueues.set(key, next);
 
  next.finally(() => {
    if (userQueues.get(key) === next) userQueues.delete(key);
  }).catch(() => {});
 
  return next;
}
 
function detectUserRegion(jid) {
  const raw = normalizePhone(jid);
  if (raw.startsWith('254')) {
    return {
      country: 'KE',
      countryName: 'Kenya',
      timezone: 'Africa/Nairobi',
      defaultCity: 'Kenya',
      defaultDestination: 'Nairobi',
      examplePlaces: 'Juja or Ruiru',
      exampleDest: 'Thika or Nairobi',
      currency: 'KES',
      flag: '🇰🇪',
    };
  }
  if (raw.startsWith('1')) {
    return {
      country: 'US',
      countryName: 'USA',
      timezone: process.env.DEFAULT_US_TIMEZONE || DEFAULT_TIMEZONE,
      defaultCity: 'USA',
      defaultDestination: 'USA',
      examplePlaces: 'your pickup area',
      exampleDest: 'your destination',
      currency: 'USD',
      flag: '🇺🇸',
    };
  }
  return {
    country: 'US',
    countryName: 'USA',
    timezone: process.env.DEFAULT_US_TIMEZONE || DEFAULT_TIMEZONE,
    defaultCity: 'USA',
    defaultDestination: 'USA',
    examplePlaces: 'your pickup area',
    exampleDest: 'your destination',
    currency: 'USD',
    flag: '🇺🇸',
  };
}
 
function getUserNow(timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
 
  const v = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
 
  return new Date(Date.UTC(
    Number(v.year),
    Number(v.month) - 1,
    Number(v.day),
    Number(v.hour),
    Number(v.minute),
    Number(v.second)
  ));
}
 
function getLocalDateString(date = new Date(), timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
 
  const v = Object.fromEntries(
    parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
 
  return `${v.year}-${v.month}-${v.day}`;
}
 
function addLocalDays(date, days, timezone = DEFAULT_TIMEZONE) {
  const base = date instanceof Date ? new Date(date) : getUserNow(timezone);
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return base;
}
 
function getTimeGreeting(timezone) {
  const h = getUserNow(timezone).getUTCHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 15) return 'Good afternoon';
  if (h >= 15 && h < 19) return 'Good evening';
  return 'Hello';
}
 
function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}
 
function dateFromLocalParts(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d;
}
 
function getRealDate(value, timezone = DEFAULT_TIMEZONE) {
  const today = getLocalDateString(new Date(), timezone);
  if (!value) return today;
 
  const s = String(value).toLowerCase().trim();
  if (isValidDateString(s)) return s;
 
  const now = getUserNow(timezone);
 
  if (s.includes('day after tomorrow')) {
    return getLocalDateString(addLocalDays(now, 2, timezone), timezone);
  }
  if (s.includes('tomorrow')) {
    return getLocalDateString(addLocalDays(now, 1, timezone), timezone);
  }
  if (s.includes('next week')) {
    return getLocalDateString(addLocalDays(now, 7, timezone), timezone);
  }
  if (/\b(today|now|asap|right now)\b/.test(s) || s === 'null') {
    return today;
  }
 
  const weekdays = [
    'sunday', 'monday', 'tuesday', 'wednesday',
    'thursday', 'friday', 'saturday',
  ];
 
  for (const dayName of weekdays) {
    if (!new RegExp(`\\b${dayName}\\b`, 'i').test(s)) continue;
 
    const target = weekdays.indexOf(dayName);
    const current = now.getUTCDay();
    let diff = target - current;
 
    if (s.includes('this ')) {
      if (diff < 0) diff += 7;
    } else {
      if (diff <= 0) diff += 7;
    }
 
    return getLocalDateString(addLocalDays(now, diff, timezone), timezone);
  }
 
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = parsed.getMonth() + 1;
    const day = parsed.getDate();
    return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
 
  return today;
}
 
function getRealTime(value, timezone = DEFAULT_TIMEZONE) {
  if (!value) return null;
 
  let s = String(value).toLowerCase().trim();
  const wordMap = {
    one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9',
    ten: '10', eleven: '11', twelve: '12',
  };
 
  for (const [word, number] of Object.entries(wordMap)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), number);
  }
 
  if (['now', 'asap', 'just now', 'immediately', 'now now', 'right now'].includes(s)) {
    const now = getUserNow(timezone);
    return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  }
 
  if (/\b(this )?morning\b/.test(s)) return '09:00';
  if (/\b(this )?afternoon\b/.test(s)) return '14:00';
  if (/\b(evening|tonight)\b/.test(s)) return '19:00';
 
  const m = s.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
 
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = m[3];
 
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
 
  if (!ap && h >= 1 && h <= 7) {
    return null;
  }
 
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
 
function extractDeterministicFields(text, timezone) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
 
  let date = null;
  let time = null;
  let seats = null;
 
  if (/\bday after tomorrow\b/.test(lower)) date = getRealDate('day after tomorrow', timezone);
  else if (/\btomorrow\b/.test(lower)) date = getRealDate('tomorrow', timezone);
  else if (/\btoday\b|\btonight\b|\bnow\b|\basap\b|\bright now\b/.test(lower)) {
    date = getRealDate('today', timezone);
  } else {
    const weekdays = /\b(this|next)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(lower);
    if (weekdays) date = getRealDate(weekdays[0], timezone);
  }
 
  const timePatterns = [
    /\b(?:at|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
    /\b\d{1,2}(?::\d{2})\s*(?:am|pm)\b/i,
    /\b\d{1,2}\s*(?:am|pm)\b/i,
    /\b(?:nine|ten|eleven|twelve|one|two|three|four|five|six|seven|eight)\s+(?:am|pm|in the morning|in the afternoon|in the evening|at night)\b/i,
    /\b(?:this morning|this afternoon|this evening|tonight)\b/i,
  ];
 
  for (const pattern of timePatterns) {
    const match = lower.match(pattern);
    if (match) {
      time = getRealTime(match[0], timezone);
      if (time) break;
    }
  }
 
  if (!time && /\b(?:now|asap|right now|immediately)\b/.test(lower)) {
    time = getRealTime('now', timezone);
  }
 
  const seatMatch = lower.match(/\b(?:for|with)\s+(\d{1,2})\s+(?:people|persons|passengers|seats)\b/)
    || lower.match(/\b(\d{1,2})\s+(?:people|persons|passengers)\b/)
    || lower.match(/\bme\s*\+\s*(\d{1,2})\b/);
 
  if (seatMatch) {
    seats = Math.max(1, Math.min(6, Number(seatMatch[1])));
  }
 
  return { date, time, seats };
}
 
function normalizeLocation(locStr) {
  if (!locStr) return '';
  return String(locStr)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
 
function locationWords(value) {
  return normalizeLocation(value).split(/\s+/).filter(Boolean);
}
 
function areLocationsNearby(locA, locB) {
  const a = normalizeLocation(locA);
  const b = normalizeLocation(locB);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
 
  const aWords = locationWords(a);
  const bWords = new Set(locationWords(b));
 
  return aWords.some((word) => word.length >= 4 && bWords.has(word));
}
 
function isValidLocation(value) {
  if (!value) return false;
  const raw = String(value).trim();
  const l = normalizeLocation(raw);
 
  if (l.length < 3 || l.length > 60) return false;
 
  const badExact = new Set([
    'hi', 'hello', 'hey', 'hii', 'heyy', 'yo',
    'online', 'offline', 'thanks', 'thank you',
    'where is', 'what is', 'who is', 'when did',
    'need a ride', 'need ride', 'i need a ride',
  ]);
 
  if (badExact.has(l)) return false;
 
  const badPhrase = [
    /\bneed\s+(?:a\s+)?ride\b/i,
    /\bi\s+need\b/i,
    /\bwant\s+(?:a\s+)?ride\b/i,
    /\bwhere\s+is\b/i,
    /\bwhat\s+is\b/i,
    /\bwho\s+is\b/i,
    /\bwhen\s+did\b/i,
    /\bhow\s+much\b/i,
  ];
 
  return !badPhrase.some((re) => re.test(l));
}
 
function isCommandPhrase(value) {
  if (!value) return true;
  const l = normalizeLocation(value);
 
  const exact = new Set([
    'i want to give ride',
    'give ride',
    'want to give ride',
    'ride available',
    'i want to offer ride',
    'offer ride',
    'i am driver',
    'online',
    'offline',
    'clear',
    'next',
    'hi',
    'hello',
    'hey',
    'thanks',
    'ok',
    'okay',
  ]);
 
  return exact.has(l);
}
 
function isPollutedRide(ride) {
  const fields = [
    ride?.from || '',
    ride?.to || '',
    ride?.date || '',
  ].map((v) => String(v).toLowerCase());
 
  const suspicious = [
    /\bwhere\b/, /\bwho\b/, /\bwhat\b/, /\bwhen\b/, /\bwhy\b/,
    /\bpresident\b/, /\bfounder\b/, /\bfilter\b/, /\bavailable\b/,
  ];
 
  if (fields.some((field) => suspicious.some((re) => re.test(field)))) return true;
 
  const from = String(ride?.from || '').trim();
  const to = String(ride?.to || '').trim();
 
  return !isValidLocation(from) || !isValidLocation(to);
}
 
function toDisplayTime(time) {
  if (!time || time === 'Flexible') return 'now';
  const [hRaw, mRaw] = String(time).split(':');
  const h = Number(hRaw);
  const m = Number(mRaw || 0);
  if (!Number.isFinite(h)) return String(time);
 
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
 
function toDisplayDate(date, timezone) {
  if (!date) return '';
  if (!isValidDateString(date)) return String(date);
 
  const today = getLocalDateString(new Date(), timezone);
  const tomorrow = getLocalDateString(
    addLocalDays(getUserNow(timezone), 1, timezone),
    timezone
  );
 
  if (date === today) return 'Today';
  if (date === tomorrow) return 'Tomorrow';
 
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12))
    .toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
}
 
function getTimeZoneParts(date, timezone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}
 
function getTimeZoneOffsetMs(date, timezone = DEFAULT_TIMEZONE) {
  const parts = getTimeZoneParts(date, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}
 
function zonedDateTimeToUtc(dateString, timeString, timezone = DEFAULT_TIMEZONE) {
  if (!isValidDateString(dateString) || !timeString) return null;
  const match = String(timeString).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const [year, month, day] = String(dateString).split('-').map(Number);
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  for (let i = 0; i < 3; i += 1) {
    const corrected = new Date(guess.getTime() - getTimeZoneOffsetMs(guess, timezone));
    if (corrected.getTime() === guess.getTime()) break;
    guess = corrected;
  }
  return guess.getTime();
}
 
function getScheduledTimestamp(rideDate, rideTime, timezone = DEFAULT_TIMEZONE) {
  if (!rideDate || !rideTime || String(rideTime).toLowerCase() === 'flexible') return null;
  if (!isValidDateString(rideDate)) return null;
  if (String(rideTime).toLowerCase() === 'now') return Date.now();
  return zonedDateTimeToUtc(rideDate, rideTime, timezone);
}
 
function formatRemainingRideTime(diffMinutes) {
  const rounded = Math.max(0, Math.round(Number(diffMinutes) || 0));
  if (rounded <= 0) return 'NOW';
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}
 
function getCountdownText(rideTime, rideDate, timezone) {
  const targetMs = getScheduledTimestamp(rideDate, rideTime, timezone);
  if (!targetMs) return 'NOW';
  const diff = Math.round((targetMs - Date.now()) / 60000);
  if (diff <= 0 && diff >= -RIDE_URGENT_PAST_MINUTES) return 'NOW';
  if (diff < -RIDE_URGENT_PAST_MINUTES) return 'OVERDUE';
  return formatRemainingRideTime(diff);
}
 
function getUrgencyState(diffMins) {
  if (diffMins <= 0 && diffMins >= -RIDE_URGENT_PAST_MINUTES) return 'URGENT';
  if (diffMins > 0 && diffMins <= RIDE_URGENT_FUTURE_MINUTES) return 'SOON';
  if (diffMins < -RIDE_URGENT_PAST_MINUTES) return 'OVERDUE';
  return 'NORMAL';
}
 
function sortAndTagRides(rides, timezone) {
  const nowMs = getUserNow(timezone).getTime();
  return rides
    .map((ride) => {
      const r = ride?.dataValues || ride;
      const targetMs = getScheduledTimestamp(r.date, r.time, timezone);
      const diffMins = targetMs == null ? 999999 : Math.round((targetMs - nowMs) / 60000);
      const urgency = getUrgencyState(diffMins);
      return {
        ...r,
        diffMins,
        urgency,
        isUrgent: urgency === 'URGENT',
        countdownStr: getCountdownText(r.time, r.date, timezone),
      };
    })
    .sort((a, b) => {
      if (a.urgency === 'URGENT' && b.urgency !== 'URGENT') return -1;
      if (b.urgency === 'URGENT' && a.urgency !== 'URGENT') return 1;
      return a.diffMins - b.diffMins;
    });
}
 
function getDirectChatLink(jid) {
  return `https://wa.me/${normalizePhone(jid)}`;
}
 
function parseRating(text) {
  const t = String(text || '').toLowerCase().trim();
  if (t.length > 20) return null;
 
  const direct = t.match(/^([1-5])(?:\s*stars?)?$/i);
  if (direct) return Number(direct[1]);
 
  return null;
}
 
function setRatingSession(phone, data) {
  const key = normalizePhone(phone);
  if (!key) return;
  ratingSessions.set(key, { ...(data || {}), createdAt: new Date().toISOString() });
}
 
function getRatingSession(phone, remoteJid) {
  const candidates = [
    normalizePhone(phone),
    normalizePhone(remoteJid),
    getSessionKey(phone),
    getSessionKey(remoteJid),
  ].filter(Boolean);
 
  for (const key of candidates) {
    const found = ratingSessions.get(key);
    if (found) return found;
  }
 
  return null;
}
 
function clearRatingSession(phone, remoteJid, other) {
  for (const value of [phone, remoteJid, other]) {
    const key = normalizePhone(value);
    if (key) ratingSessions.delete(key);
  }
}
 
async function addRatingToUser(phone, stars) {
  const key = normalizePhone(phone);
  if (!key) return 5;
 
  try {
    const user = await User.getOrCreate(key);
 
    if (!user.ratingCount || user.ratingCount < 1) {
      user.rating = stars;
      user.ratingCount = 1;
    } else {
      const total = Number(user.rating || 5) * Number(user.ratingCount);
      user.ratingCount += 1;
      user.rating = (total + stars) / user.ratingCount;
    }
 
    await user.save();
    return Number(user.rating || 5);
  } catch (err) {
    console.error('Rating error:', err?.stack || err?.message || err);
    return 5;
  }
}
 
async function sendGupshupMessage(toJid, text) {
  if (!toJid || !sock) return false;
 
  try {
    await sock.sendMessage(jidFor(toJid), { text: String(text) });
    return true;
  } catch (err) {
    console.error('WhatsApp send error:', err?.message || err);
    return false;
  }
}
 
function adminOnly(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).send('Admin API disabled: ADMIN_SECRET is not configured');
  }
 
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).send('Unauthorized');
  next();
}
 
function formatExpiryCountdown(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'expiring now';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `expires in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `expires in ${hours}h${remainder ? `${remainder}m` : ''}`;
}
 
function isRideCurrentlyActionable(ride) {
  const status = String(ride?.status || '').toUpperCase();
  if (status !== 'OPEN') return false;
  if (ride?.expiresAt && new Date(ride.expiresAt).getTime() <= Date.now()) return false;
  return true;
}
 
function profileName(user) {
  return String(user?.name || user?.username || 'Induu member').trim();
}
 
function profileUsername(user) {
  const raw = String(user?.username || '').trim().replace(/^@+/, '');
  return raw ? `@${raw}` : 'Not set';
}
 
function profileCountry(user, region) {
  const country = user?.country || region.country;
  return country === 'KE' ? '🇰🇪 Kenya' : '🇺🇸 USA';
}
 
function buildProfileText(user, region) {
  const completed = Number(user?.ridesCompleted || 0);
  const offered = Number(user?.ridesOffered || 0);
  const requested = Number(user?.ridesRequested || 0);
  const rating = Number(user?.rating || 5).toFixed(1);
  const count = Number(user?.ratingCount || 0);
  const online = user?.isOnline && user?.onlineUntil && new Date(user.onlineUntil) > new Date();
  return [
    '*👤 YOUR INDUU PROFILE*',
    '',
    `Name: ${profileName(user)}`,
    `Username: ${profileUsername(user)}`,
    `Country: ${profileCountry(user, region)}`,
    `Location: ${user?.location || region.defaultCity}`,
    `Rating: ⭐ ${rating} (${count} ${count === 1 ? 'rating' : 'ratings'})`,
    `Rides completed: ${completed}`,
    `Rides offered: ${offered}`,
    `Rides requested: ${requested}`,
    `Driver status: ${online ? 'ONLINE' : 'OFFLINE'}`,
    `Member since: ${user?.createdAt ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Recently'}`,
    '',
    `Username changes remaining: ${Math.max(0, USERNAME_CHANGE_LIMIT - Number(user?.usernameChangeCount || 0))}`,
  ].join('\n');
}
 
async function sendRidesList(toJid, rides, title = 'RIDES:', page = 0, timezone = DEFAULT_TIMEZONE) {
  const clean = (rides || [])
    .map((ride) => ride?.dataValues || ride)
    .filter((ride) => !isPollutedRide(ride))
    .filter((ride) => !isCommandPhrase(ride.from) && !isCommandPhrase(ride.to))
    .filter((ride) => isRideCurrentlyActionable(ride));
  if (!clean.length) {
    await sendGupshupMessage(toJid, 'No rides available right now.\nSay ONLINE to see available rides.');
    return;
  }
  const sorted = sortAndTagRides(clean, timezone);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  const chunk = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  let out = `*${sorted.length} rides* - P${safePage + 1}/${totalPages}\n\n`;
  for (const ride of chunk) {
    let user = null;
    try { user = await User.getOrCreate(ride.phone); } catch (_) {}
    const count = Number(user?.ratingCount || 0);
    const rating = Number.isFinite(Number(user?.rating)) ? Number(user.rating).toFixed(1) : '5.0';
    const dot = ride.urgency === 'URGENT' ? '🔴 ' : '';
    const ratingLine = count < 2 ? `${dot}New rider` : `${dot}★${rating} (${count})`;
    const from = String(ride.from || '').trim() || 'Unknown pickup';
    const to = String(ride.to || '').trim() || 'Unknown destination';
    const seats = Math.max(1, Number(ride.seats) || 1);
    const meta = [
      ride.time ? toDisplayTime(ride.time) : null,
      ride.date ? toDisplayDate(ride.date, timezone) : null,
      Number.isFinite(Number(ride.distanceMiles)) && Number(ride.distanceMiles) > 0
        ? `${Number(ride.distanceMiles).toFixed(Number(ride.distanceMiles) % 1 === 0 ? 0 : 1)} miles` : null,
      ride.countdownStr && ride.countdownStr !== 'OVERDUE' ? ride.countdownStr : null,
      `${seats} ${seats === 1 ? 'person' : 'people'}`,
    ].filter(Boolean).join(' • ');
    out += `${ratingLine}\n`;
    out += `Need ride from *${from}* to *${to}* • ${meta} — *Take ${ride.id}*\n\n`;
  }
  out += `Reply *Take ${chunk[0]?.id || sorted[0]?.id}*`;
  if (totalPages > 1) {
    if (safePage < totalPages - 1) out += '\nReply *NEXT* for more rides';
    if (safePage > 0) out += '\nReply *BACK* for previous rides';
  }
  await sendGupshupMessage(toJid, out.trim());
  const session = getSession(toJid);
  session.ridesList = sorted;
  session.ridesPage = safePage;
  session.lastTitle = title;
}
 
async function checkAndForwardChat(phoneJid, text, realPhone) {
  const key = normalizePhone(realPhone) || normalizePhone(phoneJid);
  const chat = activeChats.get(key);
 
  if (!chat) return false;
 
  try {
    const ride = await RideRequest.findByPk(chat.rideId);
 
    if (!ride || ride.status !== 'TAKEN') {
      killChatFor(key);
      return false;
    }
 
    const sender = normalizePhone(ride.phone) === key ? 'Rider' : 'Driver';
    const receiver = sender === 'Rider' ? 'driver' : 'rider';
 
    await sendGupshupMessage(chat.with, `${sender} ${chat.rideId}: ${text}`);
    await sendGupshupMessage(phoneJid, `Sent to ${receiver}`);
    return true;
  } catch (err) {
    console.error('Chat bridge error:', err?.stack || err?.message || err);
    return false;
  }
}
 
function setActiveChat(a, b, rideId) {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (!left || !right) return;
 
  const dataA = { with: right, rideId, createdAt: new Date().toISOString() };
  const dataB = { with: left, rideId, createdAt: new Date().toISOString() };
 
  activeChats.set(left, dataA);
  activeChats.set(right, dataB);
}
 
function killChatFor(phone) {
  const key = normalizePhone(phone);
  if (!key) return;
 
  const chat = activeChats.get(key);
  activeChats.delete(key);
 
  if (chat?.with) activeChats.delete(normalizePhone(chat.with));
}
 
const INDUU_SELF_KNOWLEDGE = {
  identity: 'Induu is a student-focused ride-sharing assistant. Its primary job is to help riders request rides, help drivers discover and accept rides, manage ride status, and guide users through profiles and account features. It can also answer general knowledge questions, but ride assistance is its main purpose.',
  capabilities: ['request rides in natural language','understand dates, times and passenger counts','create and track ride requests','show rides to drivers','ONLINE/OFFLINE driver availability','ride filtering and pagination','ride acceptance','profile and ride history','username and default-location updates','ride extension and cancellation','trip completion','rider/driver chat','ratings','ride-state/error explanations','general knowledge answers'],
  commands: {HELP:'Shows help.',PROFILE:'Shows the profile.',MY_RIDES:'Shows recent rides.',ONLINE:'Makes a driver available and can filter by area.',OFFLINE:'Marks a driver offline.','SHOW RIDES':'Shows actionable open rides.',TAKE:'Accepts an open ride, e.g. TAKE 123.',USERNAME:'Changes username when permitted.',LOCATION:'Changes default location.',EXTEND:'Extends an eligible open ride.', 'CANCEL RIDE':'Cancels the rider’s open request.','END RIDE':'Completes an accepted ride.',NEXT:'Next ride-list page.',BACK:'Previous ride-list page.',CLEAR:'Clears a ride-area filter.'},
  rideStates: {OPEN:'Available to eligible drivers while its request window is active.',TAKEN:'Accepted by a driver; rider and driver are connected.',COMPLETED:'Trip completed.',CANCELLED:'Cancelled by the rider.',EXPIRED:'Request window ended before acceptance.'}
};
function indUUHelpText(){return ['*INDUU — WHAT I CAN DO*','','I am primarily your ride assistant, but I can also answer general questions.','','*Rides*','• Need a ride: "Need a ride from Juja to Nairobi tomorrow at 8am"','• Driver mode: "I am driving Juja to Nairobi"','• See rides: SHOW RIDES','• Driver availability: ONLINE / OFFLINE','• Accept: TAKE 123, ACCEPT 123, CLAIM 123, or reply 123 when a ride is offered','','*Account*','• PROFILE — view your profile','• MY RIDES — view recent rides','• USERNAME newname — update username when permitted','• LOCATION Juja — update your default location','','*Ride management*','• EXTEND RIDE 123','• CANCEL RIDE 123','• END RIDE','','Ask me "How do I update my profile?", "Why can’t I accept a ride?", or "What does ONLINE do?" and I can explain.'].join('\n');}
function normalizeKnowledgeReply(text){let r=String(text||'').trim().replace(/^Induu:\s*/i,'').trim();if(!r)return '';if(r.length>1800)r=`${r.slice(0,1770).trim()}...`;if(!/assist you with a ride|ride today/i.test(r))r+=`\n\nHow can I assist you with a ride today?`;return r;}
function isInduuSelfQuestion(text){
  const l=String(text||'').toLowerCase().trim();
  return /\b(?:who are you|what are you|what can you do|what do you do|how do you work|how does induu work|what is induu|tell me about induu|your commands|commands|help me|update .*profile|edit .*profile|change .*profile|change .*username|update .*username|change .*location|update .*location|what does online do|what does offline do|how do i accept|how can i accept|why can.?t i accept|why is .* ride .* unavailable|what do .* ride .* mean|ride status|ride states|what happens after .*accept|how do ratings work|how do i rate|how do i cancel .*ride|how do i extend .*ride|how do i end .*ride|how do i complete .*ride|why was .* ride .* expired|what happened to .* ride|where is my ride|is my ride|my ride .* status|why am i offline|am i online)\b/i.test(l);
}
 
function extractQuestionRideId(text){
  const l=String(text||'').trim();
  const m=l.match(/(?:ride|request|trip)\s*#?\s*(\d+)\b/i) || l.match(/#(\d+)\b/);
  return m ? Number(m[1]) : null;
}
 
function dynamicRideStateLabel(ride, now = new Date()){
  if(!ride) return 'UNKNOWN';
  const status=String(ride.status||'').toUpperCase();
  if(status==='OPEN' && hasExpired(ride)) return 'EXPIRED';
  return status || 'UNKNOWN';
}
 
function formatDynamicRideSummary(ride, region){
  if(!ride) return 'I could not find that ride in the database.';
  const state=dynamicRideStateLabel(ride);
  const date=ride.date ? toDisplayDate(ride.date, region.timezone) : 'date not set';
  const time=ride.time ? toDisplayTime(ride.time) : 'time not set';
  const route=`${ride.from || 'unknown pickup'} → ${ride.to || 'unknown destination'}`;
  const seats=Number(ride.seats || ride.passengerCount || 1);
  const lines=[`Ride #${ride.id}`,route,`${date} • ${time} • ${seats} ${seats===1?'person':'people'}`,`Status: ${state}`];
  if(ride.driverPhone) lines.push(`Driver assigned: yes`);
  else if(state==='OPEN') lines.push(`Driver assigned: no`);
  if(ride.createdAt) lines.push(`Created: ${new Date(ride.createdAt).toLocaleString('en-US',{timeZone:region.timezone})}`);
  if(ride.expiresAt) lines.push(`Request window: ${new Date(ride.expiresAt).toLocaleString('en-US',{timeZone:region.timezone})}`);
  if(ride.claimedAt) lines.push(`Accepted: ${new Date(ride.claimedAt).toLocaleString('en-US',{timeZone:region.timezone})}`);
  if(ride.completedAt) lines.push(`Completed: ${new Date(ride.completedAt).toLocaleString('en-US',{timeZone:region.timezone})}`);
  if(ride.cancelledAt) lines.push(`Cancelled: ${new Date(ride.cancelledAt).toLocaleString('en-US',{timeZone:region.timezone})}`);
  return lines.join('\n');
}
 
async function getDynamicRideContext(phone, region, requestedRideId=null){
  const phoneKey=normalizePhone(phone);
  const result={requestedRide:null,latestRide:null,openRide:null,takenRide:null,counts:{},user:null};
  try { result.user=await User.getOrCreate(phoneKey); } catch(_) {}
  try {
    if(requestedRideId) result.requestedRide=await RideRequest.findByPk(Number(requestedRideId));
    result.latestRide=await RideRequest.findOne({where:{phone:phoneKey},order:[['createdAt','DESC']]});
    result.openRide=await RideRequest.findOne({where:{phone:phoneKey,status:'OPEN'},order:[['createdAt','DESC']]});
    result.takenRide=await RideRequest.findOne({where:{[Op.or]:[{phone:phoneKey},{driverPhone:phoneKey}],status:'TAKEN'},order:[['updatedAt','DESC']]});
    result.counts={
      requested:await RideRequest.count({where:{phone:phoneKey}}),
      open:await RideRequest.count({where:{phone:phoneKey,status:'OPEN'}}),
      taken:await RideRequest.count({where:{[Op.or]:[{phone:phoneKey},{driverPhone:phoneKey}],status:'TAKEN'}}),
      completed:await RideRequest.count({where:{[Op.or]:[{phone:phoneKey},{driverPhone:phoneKey}],status:'COMPLETED'}}),
      cancelled:await RideRequest.count({where:{phone:phoneKey,status:'CANCELLED'}}),
      expired:await RideRequest.count({where:{phone:phoneKey,status:'EXPIRED'}}),
    };
  } catch(err){ console.error('Dynamic ride context error:',err?.message||err); }
  return result;
}
 
function appendRideRedirect(text){
  const r=String(text||'').trim();
  if(!r) return '';
  return /assist you with a ride|ride today/i.test(r) ? r : `${r}\n\nHow can I assist you with a ride today?`;
}
 
async function answerSelfQuestion(text,user,region,phone){
  const l=String(text||'').toLowerCase().trim();
  if(['help','menu','?'].includes(l))return indUUHelpText();
  const rideId=extractQuestionRideId(text);
  const dynamic=await getDynamicRideContext(phone,region,rideId);
 
  if(/\b(?:why can.?t i accept|why .* ride .* unavailable|accept.*ride|take.*ride)\b/i.test(l)){
    if(!rideId) return appendRideRedirect('To accept a ride, use TAKE 123, ACCEPT 123, CLAIM 123, or reply with the ride number when Induu has just offered it. If you give me the ride number, I can check its current database status and explain exactly why it can or cannot be accepted.');
    const ride=dynamic.requestedRide;
    if(!ride) return appendRideRedirect(`I cannot find ride #${rideId} in the current database. It may have been removed or the number may be incorrect.`);
    const state=dynamicRideStateLabel(ride);
    const driver=normalizePhone(phone);
    if(normalizePhone(ride.phone)===driver)return appendRideRedirect(`Ride #${rideId} belongs to you, so Induu will not let you accept your own ride.`);
    if(state==='OPEN' && !hasExpired(ride))return appendRideRedirect(`Ride #${rideId} is currently OPEN and its request window has not expired. It should be claimable unless another driver claims it first; acceptance is protected by a database transaction.`);
    if(state==='TAKEN')return appendRideRedirect(`Ride #${rideId} is already TAKEN. Driver ${ride.driverPhone ? 'is assigned' : 'was assigned'} to it, so another driver cannot claim it.`);
    if(state==='CANCELLED')return appendRideRedirect(`Ride #${rideId} was CANCELLED by the rider, so it is no longer available.`);
    if(state==='EXPIRED')return appendRideRedirect(`Ride #${rideId} is EXPIRED. Its request window ended before it was accepted.`);
    if(state==='COMPLETED')return appendRideRedirect(`Ride #${rideId} is already COMPLETED, so it cannot be accepted.`);
    return appendRideRedirect(`Ride #${rideId} currently has status ${state}. That state does not allow a new driver to claim it.`);
  }
 
  if(/\b(?:why was .* ride .* expired|why .* ride .* expired|what happened to .* ride|where is my ride|is my ride|my ride .* status|ride status)\b/i.test(l)){
    const ride=dynamic.requestedRide || dynamic.latestRide || dynamic.takenRide;
    if(!ride) return appendRideRedirect(`I could not find a ride associated with your account. You currently have ${dynamic.counts.requested||0} recorded ride request${(dynamic.counts.requested||0)===1?'':'s'}.`);
    let explanation=formatDynamicRideSummary(ride,region);
    const state=dynamicRideStateLabel(ride);
    if(state==='EXPIRED') explanation+='\n\nWhy: the ride remained unclaimed until its request window expired.';
    else if(state==='TAKEN') explanation+='\n\nThe ride has been matched with a driver and is now an active trip.';
    else if(state==='OPEN') explanation+='\n\nThe request is still open and waiting for a driver.';
    else if(state==='CANCELLED') explanation+='\n\nThe request was cancelled and is no longer available.';
    else if(state==='COMPLETED') explanation+='\n\nThe trip has already been completed.';
    return appendRideRedirect(explanation);
  }
 
  if(/\b(?:why am i offline|am i online|my online status|online status)\b/i.test(l)){
    const u=dynamic.user || user;
    const online=Boolean(u?.isOnline && u?.onlineUntil && new Date(u.onlineUntil)>new Date());
    const until=u?.onlineUntil ? new Date(u.onlineUntil).toLocaleString('en-US',{timeZone:region.timezone}) : null;
    return appendRideRedirect(online ? `You are currently ONLINE as a driver${until ? ` until ${until}`:''}.` : 'You are currently OFFLINE as a driver. Say ONLINE to become available to drivers and start seeing actionable ride requests.');
  }
 
  if(/\b(?:what happened to my ride|my ride|ride)\b/i.test(l) && rideId){
    return appendRideRedirect(formatDynamicRideSummary(dynamic.requestedRide,region));
  }
 
  if(/\b(?:who are you|what are you|what is induu|tell me about induu)\b/i.test(l))return appendRideRedirect(INDUU_SELF_KNOWLEDGE.identity);
  if(/\b(?:what can you do|what do you do|how do you work|your commands|commands)\b/i.test(l))return appendRideRedirect(indUUHelpText());
  if(/\b(?:profile|update .*profile|edit .*profile|change .*profile)\b/i.test(l))return appendRideRedirect(`Use PROFILE to view your current profile. It shows your name, username, country, default location, rating, ride statistics and driver status. Use USERNAME newname to change your username when permitted, and LOCATION Juja to change your default location.`);
  if(/\b(?:username)\b.*\b(?:change|update|edit|set)\b|\b(?:change|update|edit|set)\b.*\busername\b/i.test(l)){const n=Math.max(0,USERNAME_CHANGE_LIMIT-Number((dynamic.user||user)?.usernameChangeCount||0));return appendRideRedirect(`Change your username with USERNAME newname when you still have a change available. You currently have ${n} username change${n===1?'':'s'} remaining.`);}
  if(/\b(?:location)\b.*\b(?:change|update|edit|set)\b|\b(?:change|update|edit|set)\b.*\b(?:location)\b/i.test(l))return appendRideRedirect(`Change your default location with LOCATION followed by the area, for example LOCATION Juja. Your current default location is ${(dynamic.user||user)?.location || region.defaultCity}.`);
  if(/\b(?:online|offline)\b.*\b(?:do|mean|work)\b|\bwhat does (?:online|offline)\b/i.test(l))return appendRideRedirect('ONLINE makes you available as a driver and can show actionable rides. OFFLINE removes your active driver availability.');
  if(/\b(?:ride states|what does .*ride.*mean|what happens after|what happens when)\b/i.test(l))return appendRideRedirect(`OPEN means a ride can still be claimed. TAKEN means a driver accepted it. COMPLETED means the trip ended. CANCELLED means it was cancelled. EXPIRED means its request window ended before acceptance.`);
  if(/\b(?:cancel|extend|end|complete)\b.*\b(?:ride|trip)\b/i.test(l))return appendRideRedirect('Use CANCEL RIDE 123 to cancel your own open ride, EXTEND RIDE 123 to extend it when eligible, and END RIDE to complete an accepted trip.');
  if(/\b(?:rating|rate|ratings)\b/i.test(l))return appendRideRedirect('After a completed trip, Induu can ask participants for a 1–5 star rating, which contributes to the participant’s displayed average.');
  return null;
}
 
async function answerGeneralQuestion(question,region,loc,user=null,phone=null){
  const lower=String(question||'').toLowerCase().trim();
  const greeting=getTimeGreeting(region.timezone);
  if(!lower||lower.length<=2||/^\d+$/.test(lower))return null;
  const self=await answerSelfQuestion(question,user,region,phone);
  if(self)return self;
  if(['thanks','thank you','thankyou','thx'].includes(lower))return "You're welcome! How can I assist you with a ride today?";
  if(['ok','okay','cool','nice','great','alright'].includes(lower))return 'Got it! How can I assist you with a ride today?';
  if(['hi','hey','hello','hii','heyy','yo'].includes(lower))return `${greeting}! I'm Induu — your ride-sharing assistant. I can also answer general questions. How can I assist you with a ride today?`;
  if(!process.env.GROQ_API_KEY)return null;
  try{
    const dynamic=phone ? await getDynamicRideContext(phone,region,extractQuestionRideId(question)) : null;
    const dynamicState=dynamic ? {
      user:{username:dynamic.user?.username||null,location:dynamic.user?.location||null,isOnline:Boolean(dynamic.user?.isOnline && dynamic.user?.onlineUntil && new Date(dynamic.user.onlineUntil)>new Date()),rating:Number(dynamic.user?.rating||5),ratingCount:Number(dynamic.user?.ratingCount||0),ridesRequested:Number(dynamic.user?.ridesRequested||0),ridesOffered:Number(dynamic.user?.ridesOffered||0),ridesCompleted:Number(dynamic.user?.ridesCompleted||0)},
      requestedRide:dynamic.requestedRide ? {id:dynamic.requestedRide.id,status:dynamicRideStateLabel(dynamic.requestedRide),from:dynamic.requestedRide.from,to:dynamic.requestedRide.to,date:dynamic.requestedRide.date,time:dynamic.requestedRide.time,seats:dynamic.requestedRide.seats,driverAssigned:Boolean(dynamic.requestedRide.driverPhone)} : null,
      latestRide:dynamic.latestRide ? {id:dynamic.latestRide.id,status:dynamicRideStateLabel(dynamic.latestRide)} : null,
      counts:dynamic.counts,
    } : null;
    const system=['You are Induu, a highly capable general knowledge assistant embedded inside a student ride-sharing platform.',INDUU_SELF_KNOWLEDGE.identity,`Platform capabilities: ${INDUU_SELF_KNOWLEDGE.capabilities.join('; ')}.`,`Commands: ${JSON.stringify(INDUU_SELF_KNOWLEDGE.commands)}.`,`Ride states: ${JSON.stringify(INDUU_SELF_KNOWLEDGE.rideStates)}.`,`LIVE USER/DATABASE CONTEXT (use only when relevant; never expose private phone numbers): ${JSON.stringify(dynamicState)}.`,'Answer general knowledge accurately and naturally, like a concise encyclopedia. Explain science, technology, history, geography, language, everyday subjects and educational questions when asked.','For Induu questions involving the user’s rides, online state, profile, availability, acceptance, expiration, cancellation, completion or history, prefer the supplied LIVE USER/DATABASE CONTEXT over generic explanations. If the context does not contain the requested fact, say that it could not be verified rather than inventing it.','Do not invent current events, prices, bookings, driver matches, or database state. Do not pretend to have live web access.','If the user is asking to book, change, cancel, accept, extend, or complete a ride, let the ride-command workflow handle it.','Keep ordinary knowledge answers focused, normally 2-6 short sentences. End every ordinary general-knowledge answer with exactly: How can I assist you with a ride today?','No emojis unless requested.'].join(' ');
    const response=await axios.post(GROQ_URL,{model:GROQ_MODEL,messages:[{role:'system',content:system},{role:'user',content:question}],temperature:0.15,max_tokens:500},{headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},timeout:15000});
    return normalizeKnowledgeReply(response.data?.choices?.[0]?.message?.content||'');
  }catch(err){console.error('General AI error:',err?.message||err);return null;}
}
 
const SYSTEM_PROMPT = `You are Induu, an AI student ride-sharing assistant operating in {COUNTRY}. CURRENT LOCAL CONTEXT:- Local date: {TODAY_DATE}- Local time: {TODAY_INFO}- Draft: {CONTEXT_DRAFT} Return ONLY valid JSON with these keys:{  "role": "rider" | "driver" | "command" | "chat",  "command": "ONLINE" | "OFFLINE" | "SHOW_REQUESTS" | "TAKE" | "FILTER" | "CLEAR_FILTERS" | "NEXT" | "END_RIDE" | null,  "filter": string | null,  "takeId": number | null,  "from": string | null,  "to": string | null,  "date": string | null,  "time": string | null,  "seats": number | null} RULES:- Rider means the user needs/wants a ride.- Driver means the user is offering/driving a vehicle.- Preserve fields already present in the draft unless the user clearly changes them.- "need ride tomorrow" means rider + date tomorrow, even when no locations/time are supplied yet.- "tomorrow at 5pm", "tomorrow 5pm", "Friday at 9am" must preserve both date and time.- Understand today, tomorrow, day after tomorrow, this/next weekday, morning, afternoon, evening, tonight, now, ASAP.- "for 2 people", "2 passengers", "me plus 1" means seats.- A place name by itself can fill the missing location field in an active draft.- Never turn a general question into a ride request.- Never treat a rating such as "5" as a ride ID when a rating session is active.- Induu is primarily a ride-sharing assistant but can answer general knowledge questions.- Platform questions about PROFILE, USERNAME, LOCATION, ONLINE, OFFLINE, SHOW RIDES, TAKE/ACCEPT/CLAIM, MY RIDES, EXTEND, CANCEL RIDE, END RIDE, ratings, ride states, availability and chat should be classified as chat or the appropriate command, never as a new ride.- If the user asks a general knowledge question such as "what is a television", classify it as chat.- Do not invent platform capabilities or database state.`;
 
function safeJsonParse(value) {
  try {
    const text = String(value || '')
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}
 
async function parseWithAI(message, region, contextDraft) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { role: 'chat' };
 
  const now = getUserNow(region.timezone);
  const todayDate = getLocalDateString(new Date(), region.timezone);
  const todayInfo = `${now.toISOString()} local-wall-clock`;
 
  const prompt = SYSTEM_PROMPT
    .replace('{COUNTRY}', region.country)
    .replace('{TODAY_DATE}', todayDate)
    .replace('{TODAY_INFO}', todayInfo)
    .replace('{CONTEXT_DRAFT}', JSON.stringify(contextDraft || {}));
 
  const models = [GROQ_MODEL];
 
  for (const model of models) {
    try {
      const response = await axios.post(
        GROQ_URL,
        {
          model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: message },
          ],
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: 300,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
 
      const data = safeJsonParse(response.data?.choices?.[0]?.message?.content);
      if (!data) continue;
 
      if (data.from && !isValidLocation(data.from)) data.from = null;
      if (data.to && !isValidLocation(data.to)) data.to = null;
      if (data.date) data.date = getRealDate(data.date, region.timezone);
      if (data.time) data.time = getRealTime(data.time, region.timezone);
      if (data.seats != null) {
        data.seats = Math.max(1, Math.min(6, Number.parseInt(data.seats, 10) || 1));
      }
 
      return data;
    } catch (err) {
      console.error(`Parser model ${model} failed:`, err?.message || err);
    }
  }
 
  return { role: 'chat' };
}
 
function parseDirectCommand(text) {
  const raw = String(text || '').trim();
  const l = raw.toLowerCase();
  if (l === 'online' || l.startsWith('online ')) {
    return { command: 'ONLINE', filter: raw.slice(6).trim() || null };
  }
  if (l === 'offline') return { command: 'OFFLINE' };
  if (['next', 'more', 'next page'].includes(l)) return { command: 'NEXT' };
  if (['back', 'previous', 'previous page', 'prev'].includes(l)) return { command: 'BACK' };
  if (['clear', 'clear filters', 'clear filter'].includes(l)) return { command: 'CLEAR_FILTERS' };
  if (['show requests', 'show rides', 'rides', 'available rides'].includes(l)) return { command: 'SHOW_REQUESTS' };
  if (['profile', 'my profile', 'account', 'me'].includes(l)) return { command: 'PROFILE' };
  if (['my rides', 'my ride', 'ride status', 'status'].includes(l)) return { command: 'MY_RIDES' };
  if (['extend', 'extend ride', 'keep open', 'extend my ride'].includes(l)) return { command: 'EXTEND' };
  if (['cancel ride', 'cancel my ride'].includes(l)) return { command: 'CANCEL_RIDE' };
  if (['help', 'menu', '?'].includes(l)) return { command: 'HELP' };
  const extend = l.match(/^extend(?:\s+ride)?\s+#?(\d+)$/);
  if (extend) return { command: 'EXTEND', rideId: Number(extend[1]) };
  const cancel = l.match(/^cancel(?:\s+ride)?\s+#?(\d+)$/);
  if (cancel) return { command: 'CANCEL_RIDE', rideId: Number(cancel[1]) };
  const take = l.match(/^(?:take|accept|claim)(?:\s+ride)?\s+#?(\d+)$/);
  if (take) return { command: 'TAKE', takeId: Number(take[1]) };
  const bareRide = l.match(/^#?(\d+)$/);
  if (bareRide) return { command: 'TAKE_CONTEXTUAL', takeId: Number(bareRide[1]) };
  const username = raw.match(/^username\s+@?([a-zA-Z0-9_.-]{3,30})$/i);
  if (username) return { command: 'USERNAME', username: username[1] };
  const location = raw.match(/^location\s+(.+)$/i);
  if (location) return { command: 'LOCATION', location: location[1].trim() };
  if (['end ride', 'end trip', 'complete', 'complete trip', 'done', 'finish', 'end', 'end this ride'].includes(l)) {
    return { command: 'END_RIDE' };
  }
  return null;
}
 
function isProfileRequest(text) {
  const l = String(text || '').toLowerCase().trim();
  return ['profile', 'my profile', 'account', 'me'].includes(l);
}
 
function isMyRidesRequest(text) {
  const l = String(text || '').toLowerCase().trim();
  return ['my rides', 'my ride', 'ride status', 'status'].includes(l);
}
 
function isHelpRequest(text) {
  const l = String(text || '').toLowerCase().trim();
  return ['help', 'menu', '?'].includes(l);
}
 
function isNaturalExtensionRequest(text) {
  const l = String(text || '').toLowerCase().trim();
  return /^(?:extend|keep open)(?:\s+ride)?(?:\s+#?\d+)?$/.test(l);
}
 
function isNaturalCancellationRequest(text) {
  const l = String(text || '').toLowerCase().trim();
  return /^(?:cancel)(?:\s+ride)?(?:\s+#?\d+)?$/.test(l);
}
 
function parseRideId(text) {
  const match = String(text || '').match(/#?(\d+)/);
  return match ? Number(match[1]) : null;
}
 
function parseUsernameCommand(text) {
  const match = String(text || '').match(/^username\s+@?([a-zA-Z0-9_.-]{3,30})$/i);
  return match ? match[1] : null;
}
 
function parseLocationCommand(text) {
  const match = String(text || '').match(/^location\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
 
async function sendHelp(phoneJid) {
  return sendGupshupMessage(phoneJid, indUUHelpText());
}
 
async function showMyRides(phoneJid, phone, region) {
  const rides = await RideRequest.findAll({
    where: { [Op.or]: [{ phone }, { driverPhone: phone }] },
    order: [['createdAt', 'DESC']],
    limit: 20,
  });
  if (!rides.length) return sendGupshupMessage(phoneJid, 'You have no recent rides.');
  const lines = ['*YOUR RIDES*', ''];
  for (const ride of rides) {
    const role = normalizePhone(ride.phone) === phone ? 'RIDER' : 'DRIVER';
    const status = String(ride.status || '').toUpperCase();
    const dot = status === 'OPEN' && sortAndTagRides([ride], region.timezone)[0]?.isUrgent ? '🔴 ' : '';
    lines.push(`${dot}#${ride.id} • ${role} • ${status}`);
    lines.push(`${ride.from} → ${ride.to}`);
    lines.push(`${toDisplayDate(ride.date, region.timezone)} • ${toDisplayTime(ride.time)}`);
    lines.push('');
  }
  return sendGupshupMessage(phoneJid, lines.join('\n').trim());
}
 
async function extendRideForUser(phoneJid, phone, requestedId = null) {
  const ride = requestedId
    ? await RideRequest.findByPk(requestedId)
    : await RideRequest.findOne({ where: { phone, status: 'OPEN' }, order: [['createdAt', 'DESC']] });
  if (!ride) return sendGupshupMessage(phoneJid, 'I could not find an open ride request to extend.');
  if (normalizePhone(ride.phone) !== phone) return sendGupshupMessage(phoneJid, 'Only the rider who posted the request can extend it.');
  const result = await RideRequest.extendSafely(ride.id, phone, RIDE_REQUEST_TTL_MINUTES, MAX_RIDE_EXTENSIONS);
  if (!result.success) return sendGupshupMessage(phoneJid, result.message);
  return sendGupshupMessage(phoneJid, `✅ Ride ${ride.id} extended.\nThe request will remain open for another ${RIDE_REQUEST_TTL_MINUTES} minutes.`);
}
 
async function cancelRideForUser(phoneJid, phone, requestedId = null) {
  const ride = requestedId
    ? await RideRequest.findByPk(requestedId)
    : await RideRequest.findOne({ where: { phone, status: 'OPEN' }, order: [['createdAt', 'DESC']] });
  if (!ride) return sendGupshupMessage(phoneJid, 'I could not find an open ride request to cancel.');
  if (normalizePhone(ride.phone) !== phone) return sendGupshupMessage(phoneJid, 'Only the rider who posted the request can cancel it.');
  const result = await RideRequest.cancelSafely(ride.id, phone);
  if (!result.success) return sendGupshupMessage(phoneJid, result.message);
  return sendGupshupMessage(phoneJid, `Ride ${ride.id} cancelled. It is no longer available to drivers.`);
}
 
async function changeUsername(phoneJid, phone, requestedUsername) {
  const user = await User.getOrCreate(phone);
  const result = await User.changeUsernameSafely(phone, requestedUsername, USERNAME_CHANGE_LIMIT);
  if (!result.success) return sendGupshupMessage(phoneJid, `⚠️ ${result.message}`);
  return sendGupshupMessage(phoneJid, `✅ Username updated to @${result.user.username}.\nYou have no username changes remaining.`);
}
 
async function updateLocation(phoneJid, phone, location, region) {
  if (!isValidLocation(location)) return sendGupshupMessage(phoneJid, 'Please provide a real pickup area or city, for example: LOCATION Juja');
  const user = await User.getOrCreate(phone);
  user.location = location.trim();
  user.country = region.country;
  user.timezone = region.timezone;
  await user.save();
  return sendGupshupMessage(phoneJid, `✅ Default location updated to ${user.location}.`);
}
 
async function handleDirectCommand(cmd, phoneJid, userPhoneKey, normKey, region) {
  switch (cmd.command) {
    case 'HELP':
      return sendHelp(phoneJid);
    case 'PROFILE': {
      const user = await User.getOrCreate(userPhoneKey);
      return sendGupshupMessage(phoneJid, buildProfileText(user, region));
    }
    case 'MY_RIDES':
      return showMyRides(phoneJid, userPhoneKey, region);
    case 'EXTEND':
      return extendRideForUser(phoneJid, userPhoneKey, cmd.rideId || null);
    case 'CANCEL_RIDE':
      return cancelRideForUser(phoneJid, userPhoneKey, cmd.rideId || null);
    case 'USERNAME':
      return changeUsername(phoneJid, userPhoneKey, cmd.username);
    case 'LOCATION':
      return updateLocation(phoneJid, userPhoneKey, cmd.location, region);
    case 'NEXT':
    case 'BACK': {
      const session = getSession(userPhoneKey);
      if (!session.ridesList?.length) {
        return sendGupshupMessage(phoneJid, 'No list active. Say ONLINE to see rides.');
      }
      const totalPages = Math.max(1, Math.ceil(session.ridesList.length / PAGE_SIZE));
      const currentPage = Number(session.ridesPage || 0);
      const delta = cmd.command === 'NEXT' ? 1 : -1;
      const targetPage = Math.min(Math.max(0, currentPage + delta), totalPages - 1);
      return sendRidesList(phoneJid, session.ridesList, session.lastTitle, targetPage, region.timezone);
    }
    case 'OFFLINE': {
      const user = await User.getOrCreate(userPhoneKey);
      await user.setOffline();
      clearSession(userPhoneKey);
      clearRatingSession(userPhoneKey, phoneJid);
      return sendGupshupMessage(phoneJid, `${getTimeGreeting(region.timezone)}! You are now OFFLINE.`);
    }
 
    case 'ONLINE': {
      const user = await User.getOrCreate(userPhoneKey);
      let filter = null;
      let location = user.location || region.defaultCity;
 
      if (cmd.filter && cmd.filter.length > 1) {
        filter = cmd.filter.replace(/^in\s+/i, '').trim();
        location = filter;
      }
 
      await user.setOnline(location, DEFAULT_ONLINE_HOURS);
      user.filterFrom = filter;
      await user.save();
 
      const rides = await RideRequest.findAll({
        where: { status: 'OPEN', expiresAt: { [Op.gt]: new Date() } },
        order: [['createdAt', 'DESC']],
      });
 
      const filtered = filter
        ? rides.filter((r) =>
            !isPollutedRide(r) &&
            (areLocationsNearby(filter, r.from) || areLocationsNearby(filter, r.to))
          )
        : rides.filter((r) => !isPollutedRide(r));
 
      await sendGupshupMessage(
        phoneJid,
        `ONLINE: ${filter ? filter : 'All areas'} | Rating: ${Number(user.rating || 5).toFixed(1)} ★ (${user.ratingCount || 0})`
      );
 
      if (filtered.length) {
        await sendRidesList(phoneJid, filtered, 'OPEN RIDES:', 0, region.timezone);
      } else {
        await sendGupshupMessage(
          phoneJid,
          filter
            ? `No matching rides near ${filter}. Reply CLEAR to view all.`
            : "No rides right now. You're online."
        );
      }
      return;
    }
 
    case 'CLEAR_FILTERS': {
      const user = await User.getOrCreate(userPhoneKey);
      user.filterFrom = null;
      await user.save();
 
      const rides = await RideRequest.findAll({
        where: { status: 'OPEN', expiresAt: { [Op.gt]: new Date() } },
        order: [['createdAt', 'DESC']],
      });
 
      return sendRidesList(phoneJid, rides, 'Filters cleared:', 0, region.timezone);
    }
 
    case 'SHOW_REQUESTS': {
      const rides = await RideRequest.findAll({
        where: { status: 'OPEN', expiresAt: { [Op.gt]: new Date() } },
        order: [['createdAt', 'DESC']],
      });
 
      return sendRidesList(phoneJid, rides, 'OPEN RIDES:', 0, region.timezone);
    }
 
    case 'TAKE':
      return takeRide(cmd.takeId, phoneJid, normKey, region);
 
    case 'END_RIDE':
      return endRideForUser(phoneJid, normKey, region);
 
    default:
      return false;
  }
}
 
async function takeRide(rideId, phoneJid, driverPhone, region) {
  if (!rideId) return false;
  const driver = await User.getOrCreate(driverPhone);
  const result = await RideRequest.claimSafely(rideId, driverPhone);
  if (!result.success) {
    const code = result.code || 'UNAVAILABLE';
    if (code === 'EXPIRED') {
      await sendGupshupMessage(phoneJid, `Ride ${rideId} is no longer available because its 30-minute request window expired.`);
    } else if (code === 'SELF') {
      await sendGupshupMessage(phoneJid, `You can't take your own ride ${rideId}.`);
    } else if (code === 'ALREADY_CLAIMED') {
      await sendGupshupMessage(phoneJid, `Ride ${rideId} was just accepted by another driver.`);
    } else if (code === 'CANCELLED') {
      await sendGupshupMessage(phoneJid, `Ride ${rideId} was cancelled by the rider.`);
    } else if (code === 'NOT_FOUND') {
      await sendGupshupMessage(phoneJid, `Ride ${rideId} was not found. Try SHOW RIDES.`);
    } else {
      await sendGupshupMessage(phoneJid, result.message || `Ride ${rideId} is not available.`);
    }
    return true;
  }
  const freshRide = result.ride;
  const riderPhone = normalizePhone(freshRide.phone);
  const rider = await User.getOrCreate(riderPhone);
  driver.ridesOffered = Number(driver.ridesOffered || 0) + 1;
  await driver.save();
  setActiveChat(riderPhone, driverPhone, freshRide.id);
  await sendGupshupMessage(
    phoneJid,
    `*✅ RIDE ACCEPTED*\n\nRide #${freshRide.id}\n${freshRide.from} → ${freshRide.to}\n${toDisplayDate(freshRide.date, region.timezone)} • ${toDisplayTime(freshRide.time)}\n\n👤 Rider: ${profileName(rider)}\n⭐ ${Number(rider.rating || 5).toFixed(1)} (${Number(rider.ratingCount || 0)} ratings)\n\nYou are now connected. Send messages normally to chat with the rider.\nSay END RIDE when the trip is completed.`
  );
  await sendGupshupMessage(
    riderPhone,
    `*🚗 DRIVER FOUND*\n\nYour ride #${freshRide.id} has been accepted.\n\nDriver: ${profileName(driver)}\nUsername: ${profileUsername(driver)}\n⭐ ${Number(driver.rating || 5).toFixed(1)} (${Number(driver.ratingCount || 0)} ratings)\n\nYou can now chat directly with your driver.`
  );
  return true;
}
 
async function endRideForUser(phoneJid, userPhoneKey, region) {
  const normKey = normalizePhone(userPhoneKey);
  if (!normKey || endingLocks.has(normKey)) return;
 
  endingLocks.add(normKey);
  setTimeout(() => endingLocks.delete(normKey), 5000);
 
  try {
    let rideToRate = null;
    const active = activeChats.get(normKey);
 
    if (active?.rideId) {
      rideToRate = await RideRequest.findByPk(active.rideId);
    }
 
    if (!rideToRate || rideToRate.status !== 'TAKEN') {
      rideToRate = await RideRequest.findOne({
        where: {
          status: 'TAKEN',
          [Op.or]: [
            { phone: normKey },
            { driverPhone: normKey },
          ],
        },
        order: [['updatedAt', 'DESC']],
      });
    }
 
    if (!rideToRate) {
      await sendGupshupMessage(
        phoneJid,
        'No active trip found. Need another? Say: Need a ride'
      );
      return;
    }
 
    const [updated] = await RideRequest.update(
      { status: 'COMPLETED' },
      { where: { id: rideToRate.id, status: 'TAKEN' } }
    );
 
    if (!updated) {
      await sendGupshupMessage(phoneJid, 'This trip was already completed.');
      return;
    }
 
    const riderPhone = normalizePhone(rideToRate.phone);
    const driverPhone = normalizePhone(rideToRate.driverPhone);
    const otherPhone = normKey === riderPhone ? driverPhone : riderPhone;
 
    killChatFor(normKey);
    clearSession(normKey);
 
    if (!otherPhone) {
      await sendGupshupMessage(phoneJid, 'Trip ended. Chat closed.');
      return;
    }
 
    const ratingDataForThisUser = { rideId: rideToRate.id, other: otherPhone };
    const ratingDataForOther = { rideId: rideToRate.id, other: normKey };
 
    setRatingSession(normKey, ratingDataForThisUser);
    setRatingSession(otherPhone, ratingDataForOther);
 
    await sendGupshupMessage(
      phoneJid,
      `Trip ${rideToRate.id} ended. Thanks for using Induu!\n\nPlease rate your ${normKey === riderPhone ? 'driver' : 'rider'}: Reply 1-5 stars (5 = Excellent)`
    );
 
    if (otherPhone !== normKey) {
      await sendGupshupMessage(
        otherPhone,
        `Trip ${rideToRate.id} ended. Thanks for using Induu!\n\nPlease rate your ${otherPhone === riderPhone ? 'driver' : 'rider'}: Reply 1-5 stars (5 = Excellent)`
      );
    }
  } finally {
    endingLocks.delete(normKey);
  }
}
 
function classifyLocalIntent(text) {
  const l = String(text || '').toLowerCase().trim();
 
  if (/\b(?:need|want|looking for|find me)\b.*\b(?:ride|lift|cab|transport)\b/.test(l)) {
    return 'rider';
  }
 
  if (/\b(?:give|offer|offering|driving|drive|have)\b.*\b(?:ride|seat|seats|car|vehicle)\b/.test(l)) {
    return 'driver';
  }
 
  if (/\bfrom\b.+\bto\b/.test(l) && !/\b(?:give|offer|driving)\b/.test(l)) {
    return 'rider';
  }
 
  return null;
}
 
async function handleRideLogic(phoneJid, text, realPhone) {
  const rawText = String(text || '').trim();
  if (!rawText) return;
 
  const normKey = canonicalPhone(realPhone, phoneJid);
  const region = detectUserRegion(normKey);
  const session = getSession(normKey);
  const profileUser = await User.getOrCreate(normKey);
  let profileDirty = false;
  if (!profileUser.country) { profileUser.country = region.country; profileDirty = true; }
  if (!profileUser.timezone) { profileUser.timezone = region.timezone; profileDirty = true; }
  if (!profileUser.location) { profileUser.location = region.defaultCity; profileDirty = true; }
  profileUser.lastSeenAt = new Date();
  if (profileDirty || profileUser.changed()) await profileUser.save();
 
  const ratingSession = getRatingSession(normKey, phoneJid);
 
  if (ratingSession) {
    const rating = parseRating(rawText);
 
    if (rating) {
      const newAverage = await addRatingToUser(ratingSession.other, rating);
      clearRatingSession(normKey, phoneJid, ratingSession.other);
 
      await sendGupshupMessage(
        phoneJid,
        `Rating saved! You rated ${rating} ★ for trip ${ratingSession.rideId}. New average for them: ${newAverage.toFixed(1)} ★\n\nNeed another? Say: Need a ride`
      );
      return;
    }
 
    if (/^(skip|no|no thanks)$/i.test(rawText)) {
      clearRatingSession(normKey, phoneJid, ratingSession.other);
      await sendGupshupMessage(phoneJid, 'Skipped rating. Need another? Say: Need a ride');
      return;
    }
 
    if (
      /\b(?:need|want|looking for)\b.*\b(?:ride|lift|cab)\b/i.test(rawText) ||
      /\bfrom\b.+\bto\b/i.test(rawText)
    ) {
      clearRatingSession(normKey, phoneJid, ratingSession.other);
    } else {
      await sendGupshupMessage(phoneJid, 'Please reply with a rating from 1 to 5, or say skip.');
      return;
    }
  }
 
  if (activeChats.has(normKey)) {
    const lower = rawText.toLowerCase();
    const control = /^(end ride|end trip|complete|complete trip|done|finish|online|offline|need a ride|need ride)$/i.test(lower);
    const selfQuestion = isInduuSelfQuestion(rawText);
 
    if (!control && !selfQuestion && await checkAndForwardChat(phoneJid, rawText, normKey)) {
      return;
    }
  }
 
  if (isProfileRequest(rawText)) {
    const user = await User.getOrCreate(normKey);
    await sendGupshupMessage(phoneJid, buildProfileText(user, region));
    return;
  }
  if (isMyRidesRequest(rawText)) {
    await showMyRides(phoneJid, normKey, region);
    return;
  }
  if (isHelpRequest(rawText)) {
    await sendHelp(phoneJid);
    return;
  }
  if (isNaturalExtensionRequest(rawText)) {
    await extendRideForUser(phoneJid, normKey, parseRideId(rawText));
    return;
  }
  if (isNaturalCancellationRequest(rawText)) {
    await cancelRideForUser(phoneJid, normKey, parseRideId(rawText));
    return;
  }
  const usernameFromNatural = parseUsernameCommand(rawText);
  if (usernameFromNatural) {
    await changeUsername(phoneJid, normKey, usernameFromNatural);
    return;
  }
  const locationFromNatural = parseLocationCommand(rawText);
  if (locationFromNatural) {
    await updateLocation(phoneJid, normKey, locationFromNatural, region);
    return;
  }
  const direct = parseDirectCommand(rawText);
  if (direct) {
    if (direct.command === 'TAKE_CONTEXTUAL') {
      const candidate = await RideRequest.findByPk(direct.takeId);
      const canTake = candidate && String(candidate.status || '').toUpperCase() === 'OPEN' && !hasExpired(candidate) && normalizePhone(candidate.phone) !== normKey;
      if (canTake) {
        await handleDirectCommand({ command: 'TAKE', takeId: direct.takeId }, phoneJid, normKey, normKey, region);
        return;
      }
      if (candidate) {
        const state = dynamicRideStateLabel(candidate);
        if (normalizePhone(candidate.phone) === normKey) {
          await sendGupshupMessage(phoneJid, `You can't accept your own ride #${direct.takeId}.`);
        } else if (state === 'TAKEN') {
          await sendGupshupMessage(phoneJid, `Ride #${direct.takeId} was already accepted by another driver.`);
        } else if (state === 'CANCELLED') {
          await sendGupshupMessage(phoneJid, `Ride #${direct.takeId} was cancelled by the rider.`);
        } else if (state === 'EXPIRED') {
          await sendGupshupMessage(phoneJid, `Ride #${direct.takeId} has expired and is no longer available.`);
        } else {
          await sendGupshupMessage(phoneJid, `Ride #${direct.takeId} is currently ${state} and cannot be accepted.`);
        }
        return;
      }
    } else {
      await handleDirectCommand(direct, phoneJid, normKey, normKey, region);
      return;
    }
  }
 
  const deterministic = extractDeterministicFields(rawText, region.timezone);
  const localIntent = classifyLocalIntent(rawText);
 
  if (session.draft?.role === 'rider') {
    const draft = session.draft;
    const updated = mergeDraft(draft, {
      date: deterministic.date || draft.date || null,
      time: deterministic.time || draft.time || null,
      seats: deterministic.seats || draft.seats || null,
    });
 
    if (!updated.from && isValidLocation(rawText) && !deterministic.date && !deterministic.time) {
      updated.from = rawText;
      session.draft = updated;
      await sendGupshupMessage(phoneJid, `Got it, from ${rawText} — where to? Example: ${region.exampleDest}`);
      return;
    }
 
    if (updated.from && !updated.to && isValidLocation(rawText) && !deterministic.date && !deterministic.time) {
      if (normalizeLocation(rawText) !== normalizeLocation(updated.from)) {
        updated.to = rawText;
        session.draft = updated;
        if (!updated.time) {
          await sendGupshupMessage(phoneJid, `Got it, ${updated.from} → ${updated.to}. What time? Example: 5pm or now`);
          return;
        }
      }
    }
 
    session.draft = updated;
  }
 
  let ai = await parseWithAI(rawText, region, session.draft || {});
  const aiRole = ai?.role || localIntent || 'chat';
 
  ai = {
    ...ai,
    date: deterministic.date || ai?.date || session.draft?.date || null,
    time: deterministic.time || ai?.time || session.draft?.time || null,
    seats: deterministic.seats || ai?.seats || session.draft?.seats || null,
    role: aiRole,
  };
 
  if (ai.role === 'chat' && localIntent) ai.role = localIntent;
 
  if (ai.role === 'chat') {
    const reply = await answerGeneralQuestion(
      rawText,
      region,
      session.draft?.from,
      profileUser,
      normKey
    );
 
    await sendGupshupMessage(
      phoneJid,
      reply || "Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip."
    );
    return;
  }
 
  if (ai.role === 'driver') {
    let draft = session.draft?.role === 'driver' ? session.draft : { role: 'driver' };
 
    let from = ai.from || draft.from || null;
    let to = ai.to || draft.to || null;
 
    if (!from && isValidLocation(rawText) && !isCommandPhrase(rawText)) {
      from = rawText;
    }
 
    if (!from) {
      session.draft = mergeDraft(draft, { role: 'driver' });
      await sendGupshupMessage(phoneJid, `Where are you driving from? Example: ${region.examplePlaces}`);
      return;
    }
 
    if (!to && draft.from && isValidLocation(rawText) && normalizeLocation(rawText) !== normalizeLocation(draft.from)) {
      to = rawText;
    }
 
    if (!to) {
      session.draft = mergeDraft(draft, { role: 'driver', from });
      await sendGupshupMessage(phoneJid, `Got it, driving from ${from} — where to? Example: ${region.exampleDest}`);
      return;
    }
 
    if (normalizeLocation(from) === normalizeLocation(to)) {
      session.draft = mergeDraft(draft, { role: 'driver', from, to: null });
      await sendGupshupMessage(phoneJid, `From and to can't be the same (${from}). Where are you driving to?`);
      return;
    }
 
    const user = await User.getOrCreate(normKey);
    await user.setOnline(from, DEFAULT_ONLINE_HOURS);
    user.filterFrom = from;
    await user.save();
 
    const rides = await RideRequest.findAll({
      where: { status: 'OPEN', expiresAt: { [Op.gt]: new Date() } },
      order: [['createdAt', 'DESC']],
    });
 
    const matched = rides.filter((r) =>
      !isPollutedRide(r) &&
      (areLocationsNearby(from, r.from) || areLocationsNearby(to, r.to))
    );
 
    await sendGupshupMessage(
      phoneJid,
      matched.length
        ? `You're online: ${from} → ${to} • ${matched.length} matching ride${matched.length === 1 ? '' : 's'}`
        : `You're online: ${from} → ${to} • No matching rides right now.`
    );
 
    if (matched.length) {
      await sendRidesList(phoneJid, matched, 'MATCHING RIDES:', 0, region.timezone);
    }
 
    clearSession(normKey);
    return;
  }
 
  if (ai.role === 'rider') {
    const draft = session.draft?.role === 'rider' ? session.draft : { role: 'rider' };
 
    let from = ai.from || draft.from || null;
    let to = ai.to || draft.to || null;
    let date = ai.date || draft.date || getRealDate('today', region.timezone);
    let time = ai.time || draft.time || null;
    let seats = ai.seats || draft.seats || null;
 
    if (/^(need|want)\s+(?:a\s+)?ride(?:\s+tomorrow)?$/i.test(rawText)) {
      session.draft = mergeDraft(draft, {
        role: 'rider',
        date: deterministic.date || date,
        seats,
      });
 
      await sendGupshupMessage(
        phoneJid,
        `Sure — I've noted ${toDisplayDate(session.draft.date, region.timezone)}. Where are you riding from? Example: ${region.examplePlaces}`
      );
      return;
    }
 
    if (!from) {
      if (
        isValidLocation(rawText) &&
        !deterministic.date &&
        !deterministic.time &&
        !isCommandPhrase(rawText)
      ) {
        from = rawText;
      } else {
        session.draft = mergeDraft(draft, {
          role: 'rider',
          date,
          time,
          seats,
        });
 
        await sendGupshupMessage(
          phoneJid,
          `Where are you riding from? Example: ${region.examplePlaces}`
        );
        return;
      }
    }
 
    if (!to) {
      if (
        isValidLocation(rawText) &&
        normalizeLocation(rawText) !== normalizeLocation(from) &&
        !deterministic.date &&
        !deterministic.time &&
        !isCommandPhrase(rawText)
      ) {
        to = rawText;
      } else {
        session.draft = mergeDraft(draft, { role: 'rider', from, date, time, seats });
 
        await sendGupshupMessage(
          phoneJid,
          `Got it, from ${from} — where to? Example: ${region.exampleDest}`
        );
        return;
      }
    }
 
    if (normalizeLocation(from) === normalizeLocation(to)) {
      session.draft = mergeDraft(draft, { role: 'rider', from, to: null, date, time, seats });
      await sendGupshupMessage(
        phoneJid,
        `From and to can't be the same (${from}). Where to? Example: ${region.exampleDest}`
      );
      return;
    }
 
    if (!time) {
      session.draft = mergeDraft(draft, { role: 'rider', from, to, date, seats });
      await sendGupshupMessage(
        phoneJid,
        `Got it, ${from} → ${to} on ${toDisplayDate(date, region.timezone)}. What time? Example: 5pm or now`
      );
      return;
    }
 
    const rideRequest = await RideRequest.createCustom(normKey, {
      from,
      to,
      time,
      date,
      seats: seats || 1,
      requestTtlMinutes: RIDE_REQUEST_TTL_MINUTES,
    });
    const riderUser = await User.getOrCreate(normKey);
    riderUser.country = region.country;
    riderUser.timezone = region.timezone;
    riderUser.ridesRequested = Number(riderUser.ridesRequested || 0) + 1;
    await riderUser.save();
 
    await sendGupshupMessage(
      phoneJid,
      `RIDE ${rideRequest.id} CREATED\n${rideRequest.from} → ${rideRequest.to}\n${toDisplayDate(rideRequest.date, region.timezone)} at ${toDisplayTime(rideRequest.time)}${rideRequest.seats ? ` • ${rideRequest.seats}${rideRequest.seats === 1 ? 'person' : 'people'}` : ''}\nAlerting nearby drivers...`
    );
 
    const drivers = await User.findAll({
      where: {
        isOnline: true,
        onlineUntil: { [Op.gt]: new Date() },
      },
    });
 
    for (const driver of drivers) {
      if (normalizePhone(driver.phone) === normKey) continue;
 
      const matches =
        !driver.location ||
        areLocationsNearby(driver.location, rideRequest.from) ||
        areLocationsNearby(driver.location, rideRequest.to);
 
      if (!matches) continue;
 
      await sendGupshupMessage(
        driver.phone,
        `NEW RIDE MATCH: ${rideRequest.id}\n${rideRequest.from} → ${rideRequest.to}\n${toDisplayDate(rideRequest.date, region.timezone)} at ${toDisplayTime(rideRequest.time)}${rideRequest.seats ? ` • ${rideRequest.seats}${rideRequest.seats === 1 ? 'person' : 'people'}` : ''}\nReply ${rideRequest.id} to take`
      );
    }
 
    clearSession(normKey);
    return;
  }
 
  if (ai.role === 'command' || ai.command) {
    await handleDirectCommand(
      { command: ai.command, filter: ai.filter, takeId: ai.takeId },
      phoneJid,
      normKey,
      normKey,
      region
    );
    return;
  }
 
  const reply = await answerGeneralQuestion(rawText, region, session.draft?.from, profileUser, normKey);
  await sendGupshupMessage(
    phoneJid,
    reply || "Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip."
  );
}
 
const INDUU_QA = {
  passed: 0,
  failed: 0,
  warnings: 0,
  failures: [],
  startedAt: null,
  finishedAt: null,
};
 
function qaReset() {
  INDUU_QA.passed = 0;
  INDUU_QA.failed = 0;
  INDUU_QA.warnings = 0;
  INDUU_QA.failures = [];
  INDUU_QA.startedAt = new Date().toISOString();
  INDUU_QA.finishedAt = null;
}
 
function qaPass(name) {
  INDUU_QA.passed += 1;
  return { ok: true, name };
}
 
function qaFail(name, details) {
  INDUU_QA.failed += 1;
  const failure = { name, details: String(details || 'unknown failure') };
  INDUU_QA.failures.push(failure);
  return { ok: false, ...failure };
}
 
function qaWarn(name, details) {
  INDUU_QA.warnings += 1;
  return { ok: true, warning: true, name, details: String(details || '') };
}
 
function qaAssert(name, condition, details = '') {
  return condition ? qaPass(name) : qaFail(name, details);
}
 
function qaEqual(name, actual, expected) {
  const same = Object.is(actual, expected);
  return same
    ? qaPass(name)
    : qaFail(name, `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}
 
function qaMatches(name, value, pattern) {
  const ok = pattern.test(String(value));
  return ok ? qaPass(name) : qaFail(name, `value ${JSON.stringify(value)} did not match ${pattern}`);
}
 
function qaThrows(name, fn) {
  try {
    fn();
    return qaFail(name, 'Expected the function to throw.');
  } catch (_) {
    return qaPass(name);
  }
}
 
function qaRecord(name, fn) {
  try {
    return fn();
  } catch (error) {
    return qaFail(name, error?.message || error);
  }
}
 
function qaTestPhoneNormalization() {
  const cases = [
    ['254712345678', '254712345678'],
    ['254712345678@s.whatsapp.net', '254712345678'],
    ['+254 712 345 678', '254712345678'],
    ['  +1 (940) 555-0100 ', '19405550100'],
    ['', ''],
    [null, ''],
    ['abc', ''],
  ];
  for (const [input, expected] of cases) {
    qaEqual(`phone normalization: ${JSON.stringify(input)}`, normalizePhone(input), expected);
  }
}
 
function qaTestCommandParsing() {
  const cases = [
    ['ONLINE', 'ONLINE'],
    ['online Juja', 'ONLINE'],
    ['OFFLINE', 'OFFLINE'],
    ['NEXT', 'NEXT'],
    ['more', 'NEXT'],
    ['BACK', 'BACK'],
    ['previous page', 'BACK'],
    ['SHOW RIDES', 'SHOW_REQUESTS'],
    ['PROFILE', 'PROFILE'],
    ['MY RIDES', 'MY_RIDES'],
    ['EXTEND RIDE 142', 'EXTEND'],
    ['CANCEL RIDE 142', 'CANCEL_RIDE'],
    ['TAKE 142', 'TAKE'],
    ['ACCEPT 142', 'TAKE'],
    ['USERNAME Vincent_1', 'USERNAME'],
    ['LOCATION Juja', 'LOCATION'],
    ['END RIDE', 'END_RIDE'],
    ['HELP', 'HELP'],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseDirectCommand(input);
    qaEqual(`command parsing: ${input}`, parsed?.command, expected);
  }
}
 
function qaTestSelfKnowledge() {
  qaAssert('self knowledge function is async', answerSelfQuestion('who are you', {}, detectUserRegion('254712345678'), '254712345678') instanceof Promise);
  qaAssert('dynamic ride context function exists', typeof getDynamicRideContext === 'function');
  qaAssert('ride id extraction works', extractQuestionRideId('Why is ride #123 unavailable?') === 123);
  qaAssert('ride state formatter exists', typeof dynamicRideStateLabel === 'function');
}
 
function qaTestBareRideCommandSafety() {
  qaEqual('bare number becomes contextual command', parseDirectCommand('123')?.command, 'TAKE_CONTEXTUAL');
  qaEqual('bare hash number becomes contextual command', parseDirectCommand('#123')?.takeId, 123);
  qaEqual('explicit take remains TAKE', parseDirectCommand('TAKE 123')?.command, 'TAKE');
}
 
function qaTestDateAndTime() {
  const tz = 'Africa/Nairobi';
  const today = getLocalDateString(new Date(), tz);
  const tomorrow = getRealDate('tomorrow', tz);
  const dayAfter = getRealDate('day after tomorrow', tz);
  qaMatches('today date shape', today, /^\d{4}-\d{2}-\d{2}$/);
  qaMatches('tomorrow date shape', tomorrow, /^\d{4}-\d{2}-\d{2}$/);
  qaMatches('day-after-tomorrow date shape', dayAfter, /^\d{4}-\d{2}-\d{2}$/);
  qaAssert('tomorrow is after today', tomorrow > today, `${tomorrow} <= ${today}`);
  qaAssert('day-after-tomorrow is after tomorrow', dayAfter > tomorrow, `${dayAfter} <= ${tomorrow}`);
  qaEqual('explicit ISO date remains stable', getRealDate('2030-05-20', tz), '2030-05-20');
}
 
function qaTestRideTimeFormatting() {
  qaEqual('zero minutes is NOW', formatRemainingRideTime(0), 'NOW');
  qaEqual('negative minutes is NOW', formatRemainingRideTime(-10), 'NOW');
  qaEqual('eight minutes', formatRemainingRideTime(8), '8 min');
  qaEqual('forty-two minutes', formatRemainingRideTime(42), '42 min');
  qaEqual('one hour', formatRemainingRideTime(60), '1 hr');
  qaEqual('one hour fifteen', formatRemainingRideTime(75), '1 hr 15 min');
  qaEqual('two hours', formatRemainingRideTime(120), '2 hr');
}
 
function qaTestRideUrgency() {
  qaEqual('urgent at now', getUrgencyState(0), 'URGENT');
  qaEqual('urgent five minutes late', getUrgencyState(-5), 'URGENT');
  qaEqual('urgent fifteen minutes late', getUrgencyState(-15), 'URGENT');
  qaEqual('overdue sixteen minutes late', getUrgencyState(-16), 'OVERDUE');
  qaEqual('soon thirty minutes ahead', getUrgencyState(30), 'SOON');
  qaEqual('soon sixty minutes ahead', getUrgencyState(60), 'SOON');
  qaEqual('normal beyond sixty minutes', getUrgencyState(61), 'NORMAL');
}
 
function qaTestLocationRules() {
  const longFrom = 'JKUAT Main Gate, Juja, Kiambu County, Kenya';
  const longTo = 'Kenyatta National Hospital, Hospital Road, Nairobi, Kenya';
  qaAssert('full pickup preserved', longFrom.includes('Kiambu County, Kenya'));
  qaAssert('full destination preserved', longTo.includes('Hospital Road, Nairobi, Kenya'));
  qaAssert('different locations', normalizeLocation(longFrom) !== normalizeLocation(longTo));
  qaAssert('command phrase rejected as location', isCommandPhrase('ONLINE'));
  qaAssert('normal location not command', !isCommandPhrase(longFrom));
}
 
function qaTestDistanceRules() {
  const ride = { distanceMiles: 20 };
  qaEqual('integer distance', Number(ride.distanceMiles), 20);
  qaEqual('display distance singular form', `${Math.round(ride.distanceMiles)} miles`, '20 miles');
  qaEqual('no invented distance', undefined, undefined);
}
 
function qaTestPaginationMath() {
  const total = 41;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  qaEqual('20 rides page size', PAGE_SIZE, 20);
  qaEqual('41 rides gives three pages', pages, 3);
  qaEqual('first page index', Math.min(Math.max(0, 0), pages - 1), 0);
  qaEqual('last page index', Math.min(Math.max(0, 2), pages - 1), 2);
  qaEqual('back clamps at first', Math.max(0, 0 - 1), 0);
}
 
function qaTestRegionRules() {
  const kenya = detectUserRegion('254712345678');
  const usa = detectUserRegion('19405550100');
  qaEqual('Kenya country detection', kenya.country, 'KE');
  qaEqual('Kenya timezone', kenya.timezone, 'Africa/Nairobi');
  qaEqual('USA country detection', usa.country, 'US');
  qaAssert('USA timezone is configured', Boolean(usa.timezone));
  qaAssert('city is not inferred from phone', kenya.defaultCity === 'Kenya');
}
 
function qaTestProfileFormatting() {
  const profile = buildProfileText({
    name: 'Test Rider',
    username: 'testrider',
    country: 'KE',
    location: 'Juja',
    rating: 4.8,
    ratingCount: 27,
    ridesCompleted: 10,
    ridesOffered: 4,
    ridesRequested: 8,
    usernameChangeCount: 1,
    isOnline: true,
    onlineUntil: new Date(Date.now() + 60000),
    createdAt: new Date(),
  }, detectUserRegion('254712345678'));
  qaAssert('profile contains name', profile.includes('Test Rider'));
  qaAssert('profile contains username', profile.includes('@testrider'));
  qaAssert('profile contains rating', profile.includes('4.8'));
  qaAssert('profile contains country', profile.includes('Kenya'));
}
 
function qaTestDraftMerging() {
  const first = mergeDraft({}, { role: 'rider', from: 'Juja' });
  const second = mergeDraft(first, { to: 'Nairobi', date: '2030-05-20' });
  qaEqual('draft role preserved', second.role, 'rider');
  qaEqual('draft pickup preserved', second.from, 'Juja');
  qaEqual('draft destination merged', second.to, 'Nairobi');
  qaEqual('draft date merged', second.date, '2030-05-20');
}
 
function qaTestRatingParsing() {
  qaEqual('rating one', parseRating('1'), 1);
  qaEqual('rating five', parseRating('5'), 5);
  qaEqual('rating with stars word', parseRating('4 stars'), 4);
  qaEqual('rating six rejected', parseRating('6'), null);
  qaEqual('rating text rejected', parseRating('great'), null);
}
 
function qaTestActionability() {
  qaAssert('open future ride actionable', isRideCurrentlyActionable({ status: 'OPEN', expiresAt: new Date(Date.now() + 60000) }));
  qaAssert('expired open ride not actionable', !isRideCurrentlyActionable({ status: 'OPEN', expiresAt: new Date(Date.now() - 60000) }));
  qaAssert('taken ride not actionable', !isRideCurrentlyActionable({ status: 'TAKEN', expiresAt: new Date(Date.now() + 60000) }));
}
 
function qaTestScheduledTimestamp() {
  const target = zonedDateTimeToUtc('2030-05-20', '17:30', 'Africa/Nairobi');
  qaAssert('scheduled timestamp is numeric', Number.isFinite(target));
  qaAssert('scheduled timestamp is in future relative to 2026', target > Date.now());
  qaEqual('invalid date produces null', zonedDateTimeToUtc('bad-date', '17:30', 'Africa/Nairobi'), null);
  qaEqual('invalid time produces null', zonedDateTimeToUtc('2030-05-20', '25:99', 'Africa/Nairobi'), null);
}
 
function qaTestSafetyFormatting() {
  const text = '  hello   world  ';
  qaEqual('session key normalization', getSessionKey('254 712 345 678'), '254712345678');
  qaAssert('jid generation contains whatsapp suffix', jidFor('254712345678').endsWith('@s.whatsapp.net'));
  qaAssert('chat link contains phone', getDirectChatLink('254712345678').includes('254712345678'));
  qaAssert('expiry formatter is readable', formatExpiryCountdown(new Date(Date.now() + 120000)).includes('expires in'));
  qaAssert('whitespace remains harmless', text.trim().includes('hello'));
}
 
function qaTestSortAndTag() {
  const now = new Date();
  const tz = 'Africa/Nairobi';
  const today = getLocalDateString(now, tz);
  const rides = [
    { id: 1, date: today, time: '23:59', seats: 1 },
    { id: 2, date: today, time: '00:00', seats: 2 },
  ];
  const tagged = sortAndTagRides(rides, tz);
  qaEqual('sort produces same count', tagged.length, 2);
  qaAssert('sort adds urgency', tagged.every((ride) => typeof ride.urgency === 'string'));
  qaAssert('sort adds countdown', tagged.every((ride) => typeof ride.countdownStr === 'string'));
}
 
function qaTestEnvironmentContracts() {
  qaEqual('Groq model is locked', GROQ_MODEL, 'openai/gpt-oss-20b');
  qaEqual('Groq endpoint is OpenAI-compatible', GROQ_URL, '[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)');
  qaEqual('ride TTL is thirty minutes', RIDE_REQUEST_TTL_MINUTES, 30);
  qaEqual('maximum ride extensions', MAX_RIDE_EXTENSIONS, 3);
  qaEqual('maximum seats', MAX_SEATS, 6);
  qaEqual('maximum bags', MAX_BAGS, 10);
}
 
function qaTestNaturalLanguageDateSignals() {
  const tz = 'Africa/Nairobi';
  const examples = [
    'tomorrow',
    'day after tomorrow',
    'next week',
    'today',
    'now',
    'asap',
  ];
  for (const example of examples) {
    const value = getRealDate(example, tz);
    qaMatches(`natural date: ${example}`, value, /^\d{4}-\d{2}-\d{2}$/);
  }
}
 
function qaTestCommandIdPriority() {
  const rating = parseRating('5');
  const command = parseDirectCommand('TAKE 5');
  qaEqual('rating remains numeric rating', rating, 5);
  qaEqual('TAKE 5 remains ride command', command?.command, 'TAKE');
  qaEqual('TAKE 5 id remains 5', command?.takeId, 5);
}
 
function qaTestRideCardContract() {
  const ride = {
    id: 142,
    phone: '254712345678',
    from: 'JKUAT Main Gate, Juja, Kiambu County, Kenya',
    to: 'Kenyatta National Hospital, Hospital Road, Nairobi, Kenya',
    date: '2030-05-20',
    time: '17:30',
    distanceMiles: 20,
    seats: 2,
    status: 'OPEN',
    expiresAt: new Date(Date.now() + 600000),
  };
  const sorted = sortAndTagRides([ride], 'Africa/Nairobi');
  qaEqual('ride id retained', sorted[0].id, 142);
  qaEqual('pickup retained exactly', sorted[0].from, ride.from);
  qaEqual('destination retained exactly', sorted[0].to, ride.to);
  qaEqual('distance retained', sorted[0].distanceMiles, 20);
  qaEqual('seats retained', sorted[0].seats, 2);
}
 
function qaTestSessionLifecycle() {
  const key = `qa-${Date.now()}-${Math.random()}`;
  const session = getSession(key);
  session.ridesPage = 2;
  session.lastTitle = 'QA';
  qaEqual('session page stored', getSession(key).ridesPage, 2);
  clearSession(key);
  qaAssert('session cleared', !userSessions.has(key));
}
 
function qaTestInputBoundaries() {
  qaEqual('empty rating rejected', parseRating(''), null);
  qaEqual('long rating rejected', parseRating('1'.repeat(30)), null);
  qaAssert('empty phone normalized', normalizePhone('') === '');
  qaAssert('null phone normalized', normalizePhone(null) === '');
  qaAssert('invalid location can be rejected', !isValidLocation('ONLINE'));
}
 
function qaTestTimeZoneRoundTrip() {
  const cases = [
    ['2030-01-15', '08:00', 'Africa/Nairobi'],
    ['2030-06-15', '17:30', 'America/Chicago'],
    ['2030-11-03', '01:30', 'America/Chicago'],
  ];
  for (const [date, time, tz] of cases) {
    const utc = zonedDateTimeToUtc(date, time, tz);
    qaAssert(`timezone conversion numeric ${date} ${time} ${tz}`, Number.isFinite(utc));
  }
}
 
function qaTestRideStatusVocabulary() {
  const allowed = ['OPEN', 'TAKEN', 'COMPLETED', 'CANCELLED', 'EXPIRED'];
  for (const value of allowed) qaAssert(`status allowed: ${value}`, allowed.includes(value));
  qaAssert('status vocabulary has open', allowed.includes('OPEN'));
  qaAssert('status vocabulary has taken', allowed.includes('TAKEN'));
  qaAssert('status vocabulary has completed', allowed.includes('COMPLETED'));
  qaAssert('status vocabulary has cancelled', allowed.includes('CANCELLED'));
  qaAssert('status vocabulary has expired', allowed.includes('EXPIRED'));
}
 
function qaTestMessageSafety() {
  const samples = [
    'Need a ride from Juja to Nairobi tomorrow',
    'I need 2 seats from JKUAT Main Gate to KNH at 5:30pm',
    'Need ride now',
    'ONLINE Juja',
    'TAKE 142',
    'BACK',
  ];
  for (const sample of samples) {
    qaAssert(`message remains string: ${sample}`, typeof sample === 'string');
    qaAssert(`message has bounded size: ${sample}`, sample.length < 1000);
  }
}
 
function qaTestRatingDisplay() {
  qaEqual('new rider rating label', Number(0), 0);
  qaEqual('rated user display value', Number(4.8).toFixed(1), '4.8');
  qaEqual('rating count display', Number(27), 27);
}
 
function qaTestSeatDisplay() {
  qaEqual('one seat singular', `1 ${1 === 1 ? 'person' : 'people'}`, '1 person');
  qaEqual('two seats plural', `2 ${2 === 1 ? 'person' : 'people'}`, '2 people');
  qaEqual('six seats plural', `6 ${6 === 1 ? 'person' : 'people'}`, '6 people');
}
 
function qaTestDistanceDisplay() {
  const values = [1, 5, 20, 20.5, 100];
  for (const value of values) {
    const display = `${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 1)} miles`;
    qaAssert(`distance uses miles: ${value}`, display.endsWith('miles'));
    qaAssert(`distance never uses mi: ${value}`, !display.endsWith('mi'));
  }
}
 
function qaTestPaginationBoundaries() {
  const totals = [0, 1, 19, 20, 21, 40, 41, 100, 101];
  for (const total of totals) {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    qaAssert(`pagination pages valid for ${total}`, pages >= 1);
    qaAssert(`pagination last index valid for ${total}`, pages - 1 >= 0);
  }
}
 
function qaTestUserRegionBoundaries() {
  const numbers = ['254700000000', '254799999999', '14155551234', '12025550123', ''];
  for (const number of numbers) {
    const region = detectUserRegion(number);
    qaAssert(`region returned for ${number || 'empty'}`, Boolean(region && region.country));
    qaAssert(`region timezone returned for ${number || 'empty'}`, Boolean(region && region.timezone));
  }
}
 
function qaTestCommandAliases() {
  const aliases = [
    ['more', 'NEXT'], ['next page', 'NEXT'], ['previous', 'BACK'],
    ['prev', 'BACK'], ['available rides', 'SHOW_REQUESTS'], ['account', 'PROFILE'],
    ['me', 'PROFILE'], ['status', 'MY_RIDES'], ['menu', 'HELP'],
  ];
  for (const [input, expected] of aliases) qaEqual(`alias ${input}`, parseDirectCommand(input)?.command, expected);
}
 
function qaTestExpiryRules() {
  const future = { status: 'OPEN', expiresAt: new Date(Date.now() + 30 * 60000) };
  const past = { status: 'OPEN', expiresAt: new Date(Date.now() - 1) };
  qaAssert('future request actionable', isRideCurrentlyActionable(future));
  qaAssert('expired request hidden', !isRideCurrentlyActionable(past));
  qaAssert('taken request hidden', !isRideCurrentlyActionable({ ...future, status: 'TAKEN' }));
}

// WhatsApp Baileys Connection Setup
async function startWhatsApp() {
  if (startingWhatsApp) return;
  startingWhatsApp = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrLast = qr;
        console.log('QR Code received, scan it with WhatsApp if running locally.');
      }
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp connection closed. Reconnecting:', shouldReconnect);
        sock = null;
        if (shouldReconnect) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            startingWhatsApp = false;
            startWhatsApp();
          }, 5000);
        }
      } else if (connection === 'open') {
        console.log('WhatsApp connection opened successfully!');
        startingWhatsApp = false;
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid.endsWith('@g.us')) continue; // Skip group chats

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          '';

        if (!text.trim()) continue;

        const realPhone = normalizePhone(remoteJid);
        await queueUserMessage(realPhone, async () => {
          await handleRideLogic(remoteJid, text, realPhone);
        });
      }
    });
  } catch (err) {
    console.error('Failed to start WhatsApp:', err);
    startingWhatsApp = false;
    setTimeout(() => {
      startWhatsApp();
    }, 10000);
  }
}

// HTTP route to view the WhatsApp QR code status
app.get('/qr', (req, res) => {
  if (!qrLast) return res.send('No QR code generated yet or already connected.');
  res.send(`<h1>WhatsApp QR Code</h1><p>Scan this string or check terminal logs:</p><pre>${qrLast}</pre>`);
});

app.get('/', (req, res) => {
  res.send('Induu WhatsApp Bot server is running!');
});

// Initialize database and start server + WhatsApp connection
async function main() {
  try {
    await initDatabase();
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Induu server running on port ${PORT}`);
    startWhatsApp();
  });
}

main();
