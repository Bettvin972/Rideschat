require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { Op } = require('sequelize');
const { sequelize, User, RideRequest, RideOffer } = require('./database');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
sequelize.sync({ alter: true }).then(() => console.log('DB Synced')).catch(e => console.error('DB sync error:', e.stack || e.message));

let sock = null;
let qrLast = null;
const AUTH_PATH = path.join(__dirname, 'auth_info');
const userSessions = {};
const activeChats = {};
const ratingSessions = {};
const endingLocks = new Set();
const userQueues = new Map();
let reconnectTimer = null;
let startingWhatsApp = false;

function queueUserMessage(phone, task) {
    const key = normalizePhone(phone) || String(phone || 'unknown');
    const previous = userQueues.get(key) || Promise.resolve();
    const next = previous.then(task, task).catch(err => {
        console.error('User queue error:', err.stack || err.message || err);
    });
    userQueues.set(key, next);
    return next;
}

function adminOnly(req, res, next) {
    const secret = process.env.ADMIN_SECRET;
    if (!secret) return res.status(503).send('Admin API disabled: ADMIN_SECRET is not configured');
    const auth = req.get('authorization') || '';
    if (auth!== `Bearer ${secret}`) return res.status(401).send('Unauthorized');
    next();
}

function detectUserRegion(jid) {
    const rawDigits = (jid || '').split('@')[0].replace(/[^0-9]/g, '');
    if (rawDigits.startsWith('1') || (rawDigits.length === 10 &&!rawDigits.startsWith('0'))) {
        return { country: 'US', timezone: 'America/Chicago', defaultCity: 'Denton', defaultDestination: 'Dallas', examplePlaces: 'Denton or Frisco', exampleDest: 'Dallas or Fort Worth' };
    }
    if (rawDigits.startsWith('254') || (rawDigits.startsWith('0') && rawDigits.length === 10)) {
        return { country: 'KE', timezone: 'Africa/Nairobi', defaultCity: 'Juja', defaultDestination: 'Nairobi', examplePlaces: 'Juja or Ruiru', exampleDest: 'Thika or Nairobi' };
    }
    return { country: 'US', timezone: 'America/Chicago', defaultCity: 'Main Campus', defaultDestination: 'Downtown', examplePlaces: 'Campus or North Side', exampleDest: 'Downtown or Station' };
}
function normalizeLocation(locStr) {
    if (!locStr) return '';
    return locStr.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
function areLocationsNearby(locA, locB) {
    const cleanA = normalizeLocation(locA);
    const cleanB = normalizeLocation(locB);
    if (!cleanA ||!cleanB) return false;
    if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;
    const wordsA = cleanA.split(/\s+/);
    const wordsB = cleanB.split(/\s+/);
    return wordsA.some(w => w.length > 3 && wordsB.includes(w));
}
function getUserNow(timezone) {
    const tz = timezone || 'America/Chicago';
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter(p => p.type!== 'literal').map(p => [p.type, p.value]));
    return new Date(Date.UTC(+values.year, +values.month - 1, +values.day, +values.hour, +values.minute, +values.second));
}
function getLocalDateString(date = new Date(), timezone = 'America/Chicago') {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const v = Object.fromEntries(parts.filter(p => p.type!== 'literal').map(p => [p.type, p.value]));
    return `${v.year}-${v.month}-${v.day}`;
}
function addLocalDays(date, days, timezone) {
    const local = getUserNow(timezone);
    const base = date instanceof Date? new Date(date) : new Date(local);
    base.setUTCDate(base.getUTCDate() + days);
    return base;
}
function getTimeGreeting(timezone) {
    const h = getUserNow(timezone).getUTCHours();
    if (h >= 5 && h < 12) return "Good morning";
    if (h >= 12 && h < 15) return "Good afternoon";
    if (h >= 15 && h < 19) return "Good evening";
    return "Hello";
}
function getCountdownText(rideTimeStr, rideDateStr, timezone) {
    const now = getUserNow(timezone);
    if (!rideTimeStr || rideTimeStr === 'now' || rideTimeStr === 'Flexible') return 'NOW';
    const parts = String(rideTimeStr).split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1] || '0', 10);
    if (Number.isNaN(h) || h < 0 || h > 23 || m < 0 || m > 59) return 'NOW';
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(rideDateStr || ''))
      ? rideDateStr : getLocalDateString(new Date(), timezone);
    const [yy, mm, dd] = dateStr.split('-').map(Number);
    const target = new Date(Date.UTC(yy, mm - 1, dd, h, m, 0));
    const diffMins = Math.round((target.getTime() - now.getTime()) / 60000);
    if (diffMins <= 0 && diffMins > -30) return 'NOW';
    if (diffMins <= -30) return 'OVERDUE';
    if (diffMins < 60) return `in ${diffMins}m`;
    const diffHours = Math.floor(diffMins / 60);
    const remMins = diffMins % 60;
    return `in ${diffHours}h${remMins > 0? remMins + 'm' : ''}`;
}
function sortAndTagRides(rides, timezone) {
    const now = getUserNow(timezone);
    return rides.map(ride => {
        let target = new Date(now);
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(ride.date || ''))? ride.date : getLocalDateString(new Date(), timezone);
        const [yy, mm, dd] = date.split('-').map(Number);
        let h = now.getUTCHours(), m = now.getUTCMinutes();
        if (ride.time && ride.time!== 'now' && ride.time!== 'Flexible') {
            const parts = String(ride.time).split(':');
            const parsedH = parseInt(parts[0], 10);
            const parsedM = parseInt(parts[1] || '0', 10);
            if (!Number.isNaN(parsedH)) { h = parsedH; m = Number.isNaN(parsedM)? 0 : parsedM; }
        }
        target = new Date(Date.UTC(yy, mm - 1, dd, h, m, 0));
        const diffMins = Math.round((target.getTime() - now.getTime()) / 60000);
        const isUrgent = diffMins >= -30 && diffMins <= 60;
        return {...ride, diffMins, isUrgent, countdownStr: getCountdownText(ride.time, ride.date, timezone) };
    }).sort((a, b) => {
        if (a.isUrgent &&!b.isUrgent) return -1;
        if (!a.isUrgent && b.isUrgent) return 1;
        return a.diffMins - b.diffMins;
    });
}
function normalizePhone(jid) {
    if (!jid) return '';
    return String(jid).split('@')[0].replace(/[^0-9]/g, '');
}
function canonicalPhone(realPhone, remoteJid) {
    return normalizePhone(realPhone) || normalizePhone(remoteJid);
}
function getSession(phone) {
    const key = normalizePhone(phone) || String(phone || '');
    if (!userSessions[key]) userSessions[key] = { draft: {}, lastUpdated: Date.now() };
    userSessions[key].lastUpdated = Date.now();
    return userSessions[key];
}
function clearSession(phone) { delete userSessions[normalizePhone(phone) || String(phone || '')]; }
function killChatFor(phone) {
    const norm = normalizePhone(phone);
    for (const k of Object.keys(activeChats)) {
        const chat = activeChats[k];
        const normK = normalizePhone(k);
        const normWith = normalizePhone(chat && chat.with);
        if (normK === norm || normWith === norm) {
            const other = chat && chat.with? normalizePhone(chat.with) : null;
            delete activeChats[k];
            if (other) delete activeChats[other];
        }
    }
}
function getNextWeekday(targetDay, timezone) {
    const now = getUserNow(timezone);
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const target = days.indexOf(String(targetDay).toLowerCase());
    if (target === -1) return null;
    let diff = target - now.getUTCDay();
    if (diff <= 0) diff += 7;
    return getLocalDateString(addLocalDays(now, diff, timezone), timezone);
}
function getRealDate(aiDate, timezone) {
    const now = getUserNow(timezone);
    const today = getLocalDateString(new Date(), timezone);
    if (!aiDate) return today;
    const s = String(aiDate).toLowerCase().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (s.includes('day after tomorrow')) return getLocalDateString(addLocalDays(now, 2, timezone), timezone);
    if (s.includes('tomorrow')) return getLocalDateString(addLocalDays(now, 1, timezone), timezone);
    if (s.includes('next week')) return getLocalDateString(addLocalDays(now, 7, timezone), timezone);
    if (s.includes('today') || s.includes('now') || s.includes('asap') || s === 'null') return today;
    const weekdays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    for (const d of weekdays) {
        if (!s.includes(d)) continue;
        const target = weekdays.indexOf(d);
        const todayJs = now.getUTCDay();
        const targetJs = target === 6? 0 : target + 1;
        let diff = targetJs - todayJs;
        if (s.includes('this')) {
            if (diff < 0) diff += 7;
        } else {
            if (diff <= 0) diff += 7;
        }
        return getLocalDateString(addLocalDays(now, diff, timezone), timezone);
    }
    return today;
}
function getRealTime(aiTime, timezone) {
    if (!aiTime) return null;
    const now = getUserNow(timezone);
    let l = String(aiTime).toLowerCase().trim();
    const wordMap = { one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', ten:'10', eleven:'11', twelve:'12' };
    for (const w of Object.keys(wordMap)) l = l.replace(new RegExp(`\\b${w}\\b`, 'g'), wordMap[w]);
    if (['now','asap','flexible','just now','immediately','now now'].includes(l)) {
        return `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
    }
    if (/\b(this )?morning\b/.test(l)) return '09:00';
    if (/\b(this )?afternoon\b/.test(l)) return '14:00';
    if (/\b(evening|tonight)\b/.test(l)) return '19:00';
    const m = l.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (!m) {
        const colon = l.match(/\b(\d{1,2}):(\d{2})\b/);
        if (!colon) return null;
        const h = Number(colon[1]), min = Number(colon[2]);
        return h >= 0 && h <= 23 && min >= 0 && min < 60? `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}` : null;
    }
    let h = Number(m[1]), min = Number(m[2] || 0), ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return h >= 0 && h <= 23 && min >= 0 && min < 60? `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}` : null;
}
function toDisplayTime(t) {
    if (!t || t === 'Flexible') return 'now';
    const parts = String(t).split(':');
    const h = parseInt(parts[0], 10), m = parseInt(parts[1] || '0', 10);
    if (Number.isNaN(h)) return String(t);
    return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12? 'PM' : 'AM'}`;
}
function toDisplayDate(d, timezone) {
    if (!d) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return d;
    const today = getLocalDateString(new Date(), timezone);
    const tomorrow = getLocalDateString(addLocalDays(getUserNow(timezone), 1, timezone), timezone);
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    const [y,m,day] = d.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, day, 12));
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function getDirectChatLink(jid) {
    let num = normalizePhone(jid);
    return 'https://wa.me/' + num;
}
function parseRating(txt) {
    const t = txt.toLowerCase().trim();
    if (t.length > 20) return null;
    if (/^[1-5]$/.test(t)) return parseInt(t, 10);
    if (/^[1-5]\s*stars?$/i.test(t)) return parseInt(t[0], 10);
    if (t.includes('skip') || t.includes('need a ride') || t.includes('from ') || t.includes('miles')) return null;
    if (t.length <= 10) {
        let m = t.match(/\b([1-5])\b/);
        if (m) return parseInt(m[1], 10);
    }
    return null;
}
async function addRatingToUser(phone, newRating) {
    try {
        const key = normalizePhone(phone);
        let fresh = await User.getOrCreate(key);
        let countBefore = fresh.ratingCount || 0;
        let avgBefore = fresh.rating || 5;
        if (countBefore === 0) { fresh.rating = newRating; fresh.ratingCount = 1; }
        else { fresh.rating = (avgBefore * countBefore + newRating) / (countBefore + 1); fresh.ratingCount = countBefore + 1; }
        await fresh.save();
        return fresh.rating;
    } catch(e) { return 5; }
}
function isPollutedRide(r) {
    let f = (r.from||'').toLowerCase();
    let t = (r.to||'').toLowerCase();
    let d = (r.date||'').toLowerCase();
    let bad = ['where','who','what','when','why','how','president','amazon','founder','okay','filter','end','next','available'];
    if (bad.some(b => f.includes(b) || t.includes(b) || d.includes(b))) return true;
    if (f.length<2 || t.length<2 || f.length>30 || t.length>30) return true;
    return false;
}
function isCommandPhrase(txt) {
    if (!txt) return true;
    let l = txt.toLowerCase().trim();
    let banned = ['i want to give ride','give ride','want to give ride','ride available','i want to offer ride','offer ride','i am driver','online','offline','clear','next','hi','hello','hey','thanks','ok','okay'];
    return banned.some(b => l === b || l.includes(b));
}
function isValidLocation(loc) {
    if (!loc) return false;
    let l = loc.toLowerCase().trim();
    if (l.length < 3 || l.length > 30) return false;
    let bad = ['need a ride','i need','want ride','online','offline','hi','hello','hey','thanks','where is','what is','who is','when did'];
    if (bad.some(b => l.includes(b))) return false;
    return true;
}
async function sendGupshupMessage(toJid, txt) {
    if (!toJid ||!sock) return;
    try {
        let jid = toJid.includes('@')? toJid : toJid.replace('+','').trim()+'@s.whatsapp.net';
        await sock.sendMessage(jid, { text: txt });
    } catch(e) { console.error(e.message); }
}

// --- FINAL: NO REPETITION, NO COUNTDOWN, 15 PER PAGE ---
async function sendRidesList(toJid, rides, title, page, timezone) {
    if (title === undefined) title = "RIDES:";
    if (page === undefined) page = 0;
    if (timezone === undefined) timezone = 'America/Chicago';
    if (!rides || rides.length === 0) {
        await sendGupshupMessage(toJid, "No rides right now.\nSay FILTER Nairobi or CLEAR");
        return;
    }
    let cleanRides = rides.filter(r =>!isPollutedRide(r) &&!isCommandPhrase(r.from) &&!isCommandPhrase(r.to));
    let seenPhones = new Set();
    cleanRides = cleanRides.filter(r => {
        let p = normalizePhone(r.phone);
        if (seenPhones.has(p)) return false;
        seenPhones.add(p);
        return true;
    });
    if (cleanRides.length === 0) {
        await sendGupshupMessage(toJid, "No valid rides. Try CLEAR");
        return;
    }
    const sortedRides = sortAndTagRides(cleanRides.map(r => r.dataValues || r), timezone);
    const PAGE_SIZE = 15;
    const start = page * PAGE_SIZE;
    const chunk = sortedRides.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(sortedRides.length / PAGE_SIZE);
    if (chunk.length === 0) {
        await sendGupshupMessage(toJid, "End of list. Type NEXT to restart");
        return;
    }

    let out = `*${sortedRides.length} rides* - P${page+1}/${totalPages} - Reply ID to take\n\n`;

    for (let r of chunk) {
        let rate = '5.0';
        let count = 0;
        let username = `Rider ${r.id}`;
        try {
            let u = await User.getOrCreate(r.phone);
            rate = (u.rating || 5).toFixed(1);
            count = u.ratingCount || 0;
            if (u.name && u.name.length >= 2) username = u.name;
        } catch(e) {}

        let from = (r.from || '').trim();
        let to = (r.to || '').trim();
        let niceFrom = from.charAt(0).toUpperCase() + from.slice(1);
        let niceTo = to.charAt(0).toUpperCase() + to.slice(1);
        let timeDisp = toDisplayTime(r.time);
        let dateDisp = toDisplayDate(r.date, timezone);
        let seats = r.seats || r.passengerCount || null;
        let seatsStr = seats? ` • ${seats} ${seats==1?'person':'people'}` : '';

        // SHORT - no Pick up/Drop repetition, no countdown
        out += `~ ${username} • ${rate}★${count?` (${count})`:''}\n`;
        out += `${niceFrom} → ${niceTo}\n`;
        out += `${dateDisp} at ${timeDisp}${seatsStr}\n`;
        out += `Reply ${r.id}\n\n`;
    }

    if (totalPages > 1 && page < totalPages - 1) {
        out += `NEXT for more | Reply ID e.g. ${chunk[0].id}`;
    } else {
        out += `Reply with ID e.g. ${chunk[0].id}`;
    }

    await sendGupshupMessage(toJid, out.trim());

    let sess = getSession(toJid);
    sess.ridesList = sortedRides;
    sess.ridesPage = page;
    sess.lastTitle = title;
}

async function checkAndForwardChat(phoneJid, text, realPhone) {
    const userPhoneKey = realPhone || phoneJid;
    let chat = activeChats[userPhoneKey] || activeChats[normalizePhone(userPhoneKey)];
    if (!chat) return false;
    try {
        let ride = await RideRequest.findByPk(chat.rideId);
        if (!ride || ride.status!== 'TAKEN') { killChatFor(userPhoneKey); return false; }
        let other = chat.with;
        let sender = normalizePhone(ride.phone) === normalizePhone(userPhoneKey)? "Rider" : "Driver";
        let receiver = sender === "Rider"? "driver" : "rider";
        await sendGupshupMessage(other, sender + ' ' + chat.rideId + ': ' + text);
        await sendGupshupMessage(phoneJid, 'Sent to ' + receiver);
        return true;
    } catch(e) { return false; }
}
async function answerGeneralQuestion(q, region, loc) {
    const lower = q.toLowerCase().trim();
    const greeting = getTimeGreeting(region.timezone);
    if (!lower || lower.length <= 2) return null;
    if (/^\d+$/.test(lower)) return null;
    if (['thanks','thank you','thankyou','thx'].includes(lower)) return "You're welcome!";
    if (lower.startsWith('okay') || ['ok','okay','cool','nice','great','alright'].includes(lower)) return "Got it!";
    if (['hi','hey','hello','hii','heyy','yo'].includes(lower)) return greeting + "! I'm Induu - I help students with rides.";
    if (lower.includes('who are you') || lower.includes('what are you')) return "I'm Induu! I help students connect with affordable rides near campus.";
    try {
        let sys = 'You are Induu, a friendly ride assistant. Rules: Answer in clear English, 2-3 sentences max, relevant to location ' + (loc || region.defaultCity) + ' in ' + region.country + '. No emojis.';
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b",
            messages: [{role:"system",content:sys},{role:"user",content:q}],
            temperature:0.4, max_tokens: 200
        }, { headers:{ "Authorization":`Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch(e) { return null; }
}
var SYSTEM_PROMPT = `You are Induu, an AI student ride-sharing assistant operating in {COUNTRY}.
Current Context:
- Local Time: {TODAY_INFO} [{TODAY_DATE}]
- Active Draft Session: {CONTEXT_DRAFT}
CLASSIFICATION RULES:
1. "rider": User NEEDS/WANTS a ride (e.g., "Need a ride", "taking a cab", "need ride ASAP", "from A to B", "from X to Y at 9pm", "Arlington to Chicago tomorrow for 2 people").
   - Map isolated place names or times to missing "from", "to", or "time" fields in active drafts.
   - If user says "for 2 people", "2 persons", "me plus 1", extract seats.
2. "driver": User OWNS/OFFERS a ride or vehicle (e.g., "giving ride now", "driving to X", "offering seats", "I want to offer ride").
3. "command": Action flags like ONLINE, OFFLINE, SHOW_REQUESTS, CLEAR_FILTERS, NEXT, TAKE [ID], FILTER [Location], END_RIDE.
4. "chat": Greetings or general queries when NOT filling a ride draft.
TIME RULES:
- Understand: "9 AM", "9am", "nine pm", "nine in the morning", "9 in the evening", "tonight", "this morning", "now"
- Normalize: "nine pm" => "21:00", "nine am" => "09:00", "9 in the evening" => "21:00", "tonight" => "19:00", "now" => "now"
- If user says "from A to B at nine pm", extract from=A, to=B, time=21:00
Return ONLY JSON:
{
  "role": "rider" | "driver" | "command" | "chat",
  "command": "ONLINE" | "OFFLINE" | "SHOW_REQUESTS" | "TAKE" | "FILTER" | "CLEAR_FILTERS" | "NEXT" | "END_RIDE" | null,
  "filter": string | null,
  "takeId": number | null,
  "from": string | null,
  "to": string | null,
  "date": string | null,
  "time": string | null,
  "seats": number | null
}`;
async function parseWithAI(msg, region, contextDraft) {
    if (contextDraft === undefined) contextDraft = {};
    var now = getUserNow(region.timezone);
    var todayDate = getLocalDateString(new Date(), region.timezone);
    var todayInfo = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: region.timezone }) + ' ' + todayDate + ' ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: region.timezone });
    var prompt = SYSTEM_PROMPT.replace("{COUNTRY}", region.country).replace("{TODAY_INFO}", todayInfo).replace("{TODAY_DATE}", todayDate).replace("{CONTEXT_DRAFT}", JSON.stringify(contextDraft));
    var apiKey = process.env.GROQ_API_KEY;
    var models = ["llama-3.1-8b-instant", "openai/gpt-oss-20b"];
    for (var i = 0; i < models.length; i++) {
        try {
            var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
                { model: models[i], messages: [{ role: "system", content: prompt },{ role: "user", content: msg }], temperature: 0.1, response_format: { type: "json_object" } },
                { headers: { "Authorization": "Bearer " + apiKey } }
            );
            var data = JSON.parse(res.data.choices[0].message.content.trim());
            if (data.from &&!isValidLocation(data.from)) data.from = null;
            if (data.to &&!isValidLocation(data.to)) data.to = null;
            if (data.date) { data.date = getRealDate(data.date, region.timezone); } else { data.date = null; }
            if (data.time) { data.time = getRealTime(data.time, region.timezone); } else { data.time = null; }
            if (data.seats) { data.seats = parseInt(data.seats) || null; if (data.seats > 6) data.seats = 6; }
            return data;
        } catch (e) {
            if (i === models.length - 1) return { role: "chat" };
        }
    }
}
function parseDirectCommand(text) {
    const l = String(text || '').trim().toLowerCase();
    if (l === 'online' || l.startsWith('online ')) return { command: 'ONLINE', filter: l.slice(6).trim() || null };
    if (l === 'offline') return { command: 'OFFLINE' };
    if (l === 'next' || l === 'more' || l === 'next page') return { command: 'NEXT' };
    if (l === 'clear' || l === 'clear filters' || l === 'clear filter') return { command: 'CLEAR_FILTERS' };
    if (l === 'show requests' || l === 'show rides' || l === 'rides') return { command: 'SHOW_REQUESTS' };
    if (['end ride','end trip','complete','complete trip','done','finish','end','end this ride'].includes(l)) return { command: 'END_RIDE' };
    return null;
}
async function handleDirectCommand(cmd, phoneJid, userPhoneKey, normKey, region, currentSess) {
    if (cmd.command === 'NEXT') {
        const s = getSession(userPhoneKey);
        if (!s.ridesList?.length) return sendGupshupMessage(phoneJid, 'No list active. Say ONLINE to see rides.');
        let nextPage = (s.ridesPage || 0) + 1;
        const totalPages = Math.ceil(s.ridesList.length / 15);
        if (nextPage >= totalPages) nextPage = 0;
        return sendRidesList(phoneJid, s.ridesList, s.lastTitle || 'RIDES:', nextPage, region.timezone);
    }
    if (cmd.command === 'OFFLINE') {
        const u = await User.getOrCreate(userPhoneKey);
        await u.setOffline(); clearSession(userPhoneKey);
        delete ratingSessions[userPhoneKey];
        await sendGupshupMessage(phoneJid, 'OFFLINE - ' + getTimeGreeting(region.timezone) + '!');
        return;
    }
    if (cmd.command === 'ONLINE') {
        const u = await User.getOrCreate(userPhoneKey);
        const driverLoc = (cmd.filter || u.location || region.defaultCity).replace(/^in\s+/i,'').trim();
        await u.setOnline(driverLoc, 2); u.filterFrom = driverLoc; await u.save();
        const allRides = await RideRequest.findAll({ where: { status: 'OPEN' } });
        const nearby = allRides.filter(r =>!isPollutedRide(r) &&!isCommandPhrase(r.from) && (areLocationsNearby(driverLoc, r.from) || areLocationsNearby(driverLoc, r.to)));
        await sendGupshupMessage(phoneJid, 'ONLINE: ' + driverLoc + ' | Rating: ' + (u.rating||5).toFixed(1) + ' ★ (' + (u.ratingCount||0) + ')');
        if (nearby.length) await sendRidesList(phoneJid, nearby, nearby.length + ' RIDES NEAR ' + driverLoc.toUpperCase() + ':', 0, region.timezone);
        else await sendGupshupMessage(phoneJid, 'No matching rides near ' + driverLoc + '. Reply CLEAR to view all open rides.');
        return;
    }
    if (cmd.command === 'CLEAR_FILTERS') {
        const u = await User.getOrCreate(userPhoneKey); u.filterFrom = null; await u.save();
        const nearby = await RideRequest.findAll({ where: { status: 'OPEN' } });
        return sendRidesList(phoneJid, nearby, 'Filters cleared - ' + nearby.length + ' RIDES:', 0, region.timezone);
    }
    if (cmd.command === 'SHOW_REQUESTS') {
        const nearby = await RideRequest.findAll({ where: { status: 'OPEN' } });
        return sendRidesList(phoneJid, nearby, nearby.length + ' OPEN RIDES:', 0, region.timezone);
    }
    if (cmd.command === 'END_RIDE') {
        return endRideForUser(phoneJid, userPhoneKey, normKey, region);
    }
}
async function endRideForUser(phoneJid, userPhoneKey, normKey, region) {
    if (endingLocks.has(normKey)) return;
    endingLocks.add(normKey);
    setTimeout(() => endingLocks.delete(normKey), 3000);
    const chat = activeChats[normKey];
    let rideToRate = null;
    if (chat?.rideId) rideToRate = await RideRequest.findByPk(chat.rideId);
    if (!rideToRate || rideToRate.status!== 'TAKEN') {
        rideToRate = await RideRequest.findOne({
            where: { status: 'TAKEN', [Op.or]: [{ phone: normKey }, { driverPhone: normKey }] },
            order: [['updatedAt', 'DESC']]
        });
    }
    if (!rideToRate) return sendGupshupMessage(phoneJid, 'No active trip found. Chat already closed.\nNeed another? Say: Need a ride');
    const [updated] = await RideRequest.update({ status: 'COMPLETED' }, { where: { id: rideToRate.id, status: 'TAKEN' } });
    if (!updated) return sendGupshupMessage(phoneJid, 'This trip was already completed.');
    const riderPhone = normalizePhone(rideToRate.phone);
    const driverPhone = normalizePhone(rideToRate.driverPhone);
    const otherPhone = riderPhone === normKey? driverPhone : riderPhone;
    killChatFor(normKey); clearSession(normKey);
    if (!otherPhone) return sendGupshupMessage(phoneJid, 'Trip ended. Chat closed.\nNeed another? Say: Need a ride');
    delete ratingSessions[normKey]; delete ratingSessions[otherPhone];
    ratingSessions[normKey] = { rideId: rideToRate.id, other: otherPhone };
    ratingSessions[otherPhone] = { rideId: rideToRate.id, other: normKey };
    await sendGupshupMessage(phoneJid, 'Trip ' + rideToRate.id + ' ended. Thanks for using Induu!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)');
    if (otherPhone!== normKey) await sendGupshupMessage(otherPhone, 'Trip ' + rideToRate.id + ' ended. Thanks for using Induu!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)');
}
async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        if (lowerText.length < 1) return;
        const normKey = canonicalPhone(realPhone, phoneJid);
        const userPhoneKey = normKey;
        const region = detectUserRegion(userPhoneKey);
        const rawText = text.trim();

        let ratingSess = ratingSessions[userPhoneKey] || ratingSessions[normKey] || ratingSessions[phoneJid];
        if (ratingSess) {
            if (lowerText.includes('need a ride') || lowerText.includes('need ride') || (lowerText.includes('from ') && lowerText.includes(' to ')) || lowerText.includes('miles') || rawText.length > 30) {
                delete ratingSessions[userPhoneKey];
                delete ratingSessions[normKey];
                delete ratingSessions[phoneJid];
                delete ratingSessions[normalizePhone(ratingSess.other)];
            } else {
                let rate = parseRating(lowerText);
                if (rate) {
                    let otherTarget = ratingSess.other;
                    let rideId = ratingSess.rideId;
                    let newAvg = await addRatingToUser(otherTarget, rate);
                    delete ratingSessions[userPhoneKey];
                    delete ratingSessions[normKey];
                    delete ratingSessions[phoneJid];
                    delete ratingSessions[normalizePhone(otherTarget)];
                    await sendGupshupMessage(phoneJid, 'Rating saved! You rated ' + rate + ' ★ for trip ' + rideId + '. New avg for them: ' + newAvg.toFixed(1) + ' ★\n\nNeed another? Say: Need a ride');
                    return;
                } else if (lowerText.includes('skip') || lowerText === 'no') {
                    delete ratingSessions[userPhoneKey];
                    delete ratingSessions[normKey];
                    delete ratingSessions[phoneJid];
                    await sendGupshupMessage(phoneJid, "Skipped rating. Need another? Say: Need a ride");
                    return;
                }
                if (['thanks','thank you','thankyou','thx'].includes(lowerText)) {
                    await sendGupshupMessage(phoneJid, "You're welcome! Please rate your last trip 1-5 or say skip");
                    return;
                }
            }
        }

        if (activeChats[userPhoneKey] || activeChats[normKey]) {
            const isControlCmd = ['end ride','end trip','complete','done','finish','need a ride','online','offline'].some(c => lowerText.includes(c));
            if (!isControlCmd && await checkAndForwardChat(phoneJid, text, realPhone)) return;
        }

        if (/^\d+$/.test(lowerText) || lowerText.startsWith('take ')) {
            let rideId = parseInt(lowerText.replace(/[^0-9]/g, ''), 10);
            if (rideId) {
                let ride = await RideRequest.findByPk(rideId);
                if (!ride) { await sendGupshupMessage(phoneJid, 'Ride ' + rideId + ' not found. Try ONLINE'); return; }
                if (normalizePhone(ride.phone) === normKey) { await sendGupshupMessage(phoneJid, "You can't take your own ride " + rideId); return; }
                if (ride.status!== 'OPEN') { await sendGupshupMessage(phoneJid, 'Ride ' + rideId + ' already taken'); return; }
                const [claimed] = await RideRequest.update(
                    { status: 'TAKEN', driverPhone: normKey },
                    { where: { id: rideId, status: 'OPEN' } }
                );
                if (!claimed) { await sendGupshupMessage(phoneJid, 'Ride ' + rideId + ' was just taken by another driver.'); return; }
                ride = await RideRequest.findByPk(rideId);
                const riderPhone = normalizePhone(ride.phone);
                activeChats[riderPhone] = { with: normKey, rideId: ride.id };
                activeChats[normKey] = { with: riderPhone, rideId: ride.id };
                const rider = await User.getOrCreate(riderPhone);
                const driver = await User.getOrCreate(normKey);
                await sendGupshupMessage(phoneJid, 'MATCHED ' + ride.id + ' ' + ride.from + ' -> ' + ride.to + ' ' + toDisplayTime(ride.time) + '\nRider: ' + getDirectChatLink(riderPhone) + ' | Rating: ' + (rider.rating||5).toFixed(1) + ' ★\nEND RIDE when done');
                await sendGupshupMessage(riderPhone, 'DRIVER FOUND ' + ride.id + ' ' + ride.from + ' -> ' + ride.to + '\nDriver: ' + getDirectChatLink(normKey) + ' | Rating: ' + (driver.rating||5).toFixed(1) + ' ★');
                return;
            }
        }

        if (lowerText === 'next' || lowerText === 'more' || lowerText === 'next page') {
            let s = getSession(userPhoneKey);
            if (s.ridesList && s.ridesList.length > 0) {
                let nextPage = (s.ridesPage || 0) + 1;
                let totalPages = Math.ceil(s.ridesList.length / 15);
                if (nextPage >= totalPages) nextPage = 0;
                await sendRidesList(phoneJid, s.ridesList, s.lastTitle || 'RIDES:', nextPage, region.timezone);
                return;
            } else { await sendGupshupMessage(phoneJid, "No list active. Say ONLINE to see rides."); return; }
        }

        let currentSess = getSession(userPhoneKey);

        if (currentSess.draft && currentSess.draft.role === 'rider') {
            if (!currentSess.draft.from && isValidLocation(rawText)) {
                currentSess.draft.from = rawText;
                await sendGupshupMessage(phoneJid, 'Got it, from ' + rawText + ' -- where to? Example: ' + region.exampleDest);
                return;
            }
            if (currentSess.draft.from &&!currentSess.draft.to && isValidLocation(rawText)) {
                currentSess.draft.to = rawText;
                await sendGupshupMessage(phoneJid, 'Got it, ' + currentSess.draft.from + ' -> ' + rawText + '. What time? Example: 5pm or now');
                return;
            }
        }

        const direct = parseDirectCommand(rawText);
        if (direct) {
            await handleDirectCommand(direct, phoneJid, userPhoneKey, normKey, region, currentSess);
            return;
        }

        let ai = await parseWithAI(text, region, currentSess.draft || {});

        if (ai.role === 'chat') {
            let reply = await answerGeneralQuestion(text, region, (currentSess.draft && currentSess.draft.from));
            if (!reply) reply = "Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip.";
            await sendGupshupMessage(phoneJid, reply);
            return;
        }

        if (ai.role === 'driver') {
            let draft = currentSess.draft || {};
            let from = ai.from || draft.from || null;
            let to = ai.to || draft.to || null;
            if (from &&!isValidLocation(from)) from = null;
            if (to &&!isValidLocation(to)) to = null;
            if (from && to && from.toLowerCase() === to.toLowerCase() && rawText.toLowerCase() === from.toLowerCase()) { to = null; }
            if (to && (lowerText.includes('tell me') || lowerText.includes('nearby') || lowerText.includes('what') || lowerText.length > 25)) { to = null; }
            if (!from && isValidLocation(rawText) &&!isCommandPhrase(rawText)) { from = rawText; }
            if (!from) {
                currentSess.draft = { role: 'driver' };
                await sendGupshupMessage(phoneJid, 'Where are you driving from? Example: ' + region.examplePlaces);
                return;
            }
            currentSess.draft.from = from;
            if (from &&!to) {
                if (draft.from && rawText.toLowerCase() === draft.from.toLowerCase() &&!ai.to) {
                    await sendGupshupMessage(phoneJid, 'You are already at ' + from + '. Where to? Example: ' + region.exampleDest);
                    return;
                }
                if (draft.from && isValidLocation(rawText) && rawText.toLowerCase()!== draft.from.toLowerCase() &&!isCommandPhrase(rawText) &&!lowerText.includes('tell me') &&!lowerText.includes('nearby')) {
                    if (!['now','asap'].includes(lowerText)) to = rawText;
                }
                if (!to) {
                    currentSess.draft = { role: 'driver', from: from };
                    await sendGupshupMessage(phoneJid, 'Got it, driving from ' + from + ' -- where to? Example: ' + region.exampleDest);
                    return;
                }
            }
            if (from && to && from.toLowerCase() === to.toLowerCase()) {
                await sendGupshupMessage(phoneJid, 'From and to can\'t be same (' + from + '). Where are you driving to? Example: ' + region.exampleDest);
                currentSess.draft.to = null;
                return;
            }
            currentSess.draft.to = to;
            let u = await User.getOrCreate(userPhoneKey);
            await u.setOnline(from, 2);
            u.filterFrom = from;
            await u.save();
            let allRides = await RideRequest.findAll({ where: { status: 'OPEN' } });
            let matched = allRides.filter(r => { if (isPollutedRide(r) || isCommandPhrase(r.from)) return false; return areLocationsNearby(from, r.from) || areLocationsNearby(to, r.to); });
            let ridesToShow = matched;
            await sendGupshupMessage(phoneJid, ridesToShow.length? `You're online: ${from}→${to} • ${ridesToShow.length} matching ride${ridesToShow.length!==1?'s':''}` : `You're online: ${from}→${to} • No matching rides right now.`);
            await sendRidesList(phoneJid, ridesToShow, `${ridesToShow.length} RIDES MATCHING ${from.toUpperCase()} -> ${to.toUpperCase()}:`, 0, region.timezone);
            clearSession(userPhoneKey);
            let s = getSession(userPhoneKey); s.ridesList = ridesToShow;
            return;
        }

        if (ai.role === 'rider') {
            let draft = currentSess.draft || {};
            let from = ai.from || draft.from || null;
            let to = ai.to || draft.to || null;
            let time = ai.time || draft.time || null;
            let date = ai.date || draft.date || null;
            let seats = ai.seats || draft.seats || null;
            if (from &&!isValidLocation(from)) from = null;
            if (to &&!isValidLocation(to)) to = null;

            if (['need a ride','i need a ride','need ride','i need ride'].includes(lowerText)) {
                currentSess.draft = { role: 'rider', seats: seats };
                await sendGupshupMessage(phoneJid, 'Where are you riding from? Example: ' + region.examplePlaces);
                return;
            }

            if (!from) {
                if (isValidLocation(rawText) &&!isCommandPhrase(lowerText) &&!getRealTime(rawText, region.timezone)) { from = rawText; }
                if (!from) { currentSess.draft = { role: 'rider', seats: seats }; await sendGupshupMessage(phoneJid, 'Where are you riding from? Example: ' + region.examplePlaces); return; }
                currentSess.draft = { role: 'rider', from: from, seats: seats };
                await sendGupshupMessage(phoneJid, 'Got it, from ' + from + ' -- where to? Example: ' + region.exampleDest);
                return;
            }
            if (!to) {
                if (isValidLocation(rawText) && rawText.toLowerCase()!== from.toLowerCase() &&!getRealTime(rawText, region.timezone) &&!isCommandPhrase(lowerText)) { to = rawText; }
                if (!to) { await sendGupshupMessage(phoneJid, 'Got it, from ' + from + ' -- where to? Example: ' + region.exampleDest); return; }
                if (from.toLowerCase() === to.toLowerCase()) { await sendGupshupMessage(phoneJid, 'From and to can\'t be same (' + from + '). Where to? Example: ' + region.exampleDest); return; }
                currentSess.draft = { role: 'rider', from: from, to: to, date: date, seats: seats };
                if (!time) { await sendGupshupMessage(phoneJid, 'Got it, ' + from + ' -> ' + to + '. What time?'); return; }
            }
            if (from.toLowerCase() === to.toLowerCase()) { await sendGupshupMessage(phoneJid, 'From and to can\'t be same (' + from + '). Where to?'); currentSess.draft.to = null; return; }
            if (!time) {
                let parsed = getRealTime(rawText, region.timezone);
                if (parsed) { time = parsed; } else { currentSess.draft = { role: 'rider', from: from, to: to, date: date, seats: seats }; await sendGupshupMessage(phoneJid, 'What time? Example: 5pm or now'); return; }
            }
            if (!date) date = getRealDate('today', region.timezone);
            let rideReq = await RideRequest.createCustom(userPhoneKey, { from, to, time, date, seats });
            let dispDate = toDisplayDate(date, region.timezone);
            await sendGupshupMessage(phoneJid, 'RIDE ' + rideReq.id + ' CREATED\n' + rideReq.from + ' -> ' + rideReq.to + ' ' + toDisplayTime(rideReq.time) + ' ' + dispDate + (seats? ` • ${seats} people`:'') + '\nAlerting drivers...');
            var drivers = await User.findAll({ where: { isOnline: true } });
            var filteredDrivers = drivers.filter(d => { if (normalizePhone(d.phone || '') === normKey) return false; return!d.location || areLocationsNearby(d.location, rideReq.from) || areLocationsNearby(d.location, rideReq.to); });
            for (let d of filteredDrivers) { await sendGupshupMessage(d.phone, 'NEW RIDE MATCH: ' + rideReq.id + '. ' + rideReq.from + ' -> ' + rideReq.to + ' | ' + toDisplayTime(rideReq.time) + ' ' + dispDate + (seats? ` • ${seats} people`:'') + '\nReply ' + rideReq.id + ' to take'); }
            clearSession(userPhoneKey);
            return;
        }

        if (ai.role === 'command' || ai.command) {
            await handleDirectCommand({ command: ai.command, filter: ai.filter }, phoneJid, userPhoneKey, normKey, region, currentSess);
            return;
        }

        let reply = await answerGeneralQuestion(text, region, (currentSess.draft && currentSess.draft.from));
        if (!reply) { reply = "Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip."; }
        await sendGupshupMessage(phoneJid, reply);
    } catch (err) { console.error('Error in handleRideLogic:', err.stack || err.message); }
}
async function startWhatsApp() {
    if (startingWhatsApp) return;
    startingWhatsApp = true;
    try {
        if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
        const { version } = await fetchLatestBaileysVersion();
        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['Induu Universal', 'Chrome', '1.0'],
            shouldSyncHistoryMessage: () => false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            getMessage: async () => undefined
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (u) => {
            const { connection, lastDisconnect, qr } = u;
            if (qr) qrLast = qr;
            if (connection === 'open') {
                console.log('WA Connected');
                qrLast = null;
                startingWhatsApp = false;
            }
            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;
                qrLast = null;
                sock = null;
                startingWhatsApp = false;
                if (code === DisconnectReason.loggedOut || code === 401) {
                    if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true });
                }
                if (!reconnectTimer) {
                    reconnectTimer = setTimeout(() => { reconnectTimer = null; startWhatsApp().catch(console.error); }, 5000);
                }
            }
        });
        registerMessageHandler();
    } catch (err) {
        startingWhatsApp = false;
        sock = null;
        console.error('WhatsApp startup error:', err.stack || err.message);
        if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; startWhatsApp().catch(console.error); }, 5000);
    }
}
function registerMessageHandler() {
    if (!sock) return;
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages || []) {
            try {
                if (!msg?.message || msg.key?.fromMe) continue;
                const remoteJid = msg.key.remoteJid || '';
                if (remoteJid === 'status@broadcast' || remoteJid.includes('@g.us')) continue;
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
                if (msg.message.buttonsResponseMessage) text = msg.message.buttonsResponseMessage.selectedButtonId || '';
                if (msg.message.templateButtonReplyMessage) text = msg.message.templateButtonReplyMessage.selectedId || '';
                if (msg.message.listResponseMessage) text = msg.message.listResponseMessage.singleSelectReply?.selectedRowId || '';
                if (!text) continue;
                let realPhone = remoteJid;
                if (remoteJid.includes('@lid')) {
                    if (msg.key.participant &&!msg.key.participant.includes('@lid')) realPhone = msg.key.participant;
                    else if (msg.key.remoteJidAlt &&!msg.key.remoteJidAlt.includes('@lid')) realPhone = msg.key.remoteJidAlt;
                }
                const phone = canonicalPhone(realPhone, remoteJid);
                console.log('MSG ' + phone + ': ' + text);
                await queueUserMessage(phone, () => handleRideLogic(remoteJid, text, phone));
            } catch(e) {
                if (e.message && e.message.includes('Bad MAC')) continue;
                console.error('Message handling error:', e.stack || e.message);
            }
        }
    });
}
startWhatsApp();
setInterval(async () => { try { if (RideRequest.clearExpired) await RideRequest.clearExpired(); } catch(e){} }, 15 * 60 * 1000);
app.get('/qr', adminOnly, (req, res) => {
    if (!qrLast) return res.send('<h1>Connected!</h1>');
    res.type('text/plain').send(qrLast);
});
app.get('/ping', (req, res) => { res.send('Alive'); });
app.get('/', (req, res) => { res.send('Induu LIVE - Dynamic Rides'); });
app.post('/clearall', adminOnly, async (req, res) => {
    try {
        await RideRequest.destroy({ where: {} });
        await RideOffer.destroy({ where: {} });
        Object.keys(activeChats).forEach(k => delete activeChats[k]);
        Object.keys(userSessions).forEach(k => delete userSessions[k]);
        Object.keys(ratingSessions).forEach(k => delete ratingSessions[k]);
        res.send('All rides deleted + memory cleared');
    } catch (e) {
        console.error(e);
        res.status(500).send('Failed to clear data');
    }
});
app.post('/cleardb', adminOnly, async (req, res) => {
    try {
        await sequelize.sync({ force: true });
        res.send('Full DB wiped');
    } catch (e) {
        console.error(e);
        res.status(500).send('Failed to wipe DB');
    }
});
app.get('/ratings', adminOnly, async (req, res) => {
    try {
        const users = await User.findAll();
        res.json(users.map(u => ({ phone: normalizePhone(u.phone), rating: u.rating, count: u.ratingCount })));
    } catch (e) {
        res.status(500).json({ error: 'Failed to load ratings' });
    }
});
var PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => { console.log('Induu Running on ' + PORT); });
process.on('SIGTERM', async () => {
    try { if (sock) sock.end(undefined); } catch (_) {}
    server.close(() => process.exit(0));
});
process.on('SIGINT', async () => {
    try { if (sock) sock.end(undefined); } catch (_) {}
    server.close(() => process.exit(0));
});
