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
sequelize.sync({ alter: true }).then(() => console.log("DB Synced")).catch(e => console.error(e.message));

let sock = null;
let qrLast = null;
const AUTH_PATH = path.join(__dirname, 'auth_info');
const userSessions = {};
const activeChats = {};
const ratingSessions = {};

// --- LOCATION CLUSTERING & PROXIMITY HELPERS ---
const LOCATION_ZONES = {
    'north_dfw': ['denton', 'frisco', 'plano', 'mckinney', 'little elm', 'prosper', 'lewisville'],
    'central_dfw': ['dallas', 'richardson', 'garland', 'irving', 'carrollton', 'fort worth'],
    'juja_corridor': ['juja', 'gate c', 'gate A', 'gate B', 'juja main', 'kalimoni', 'highpoint', 'ruiru', 'thika']
};
function normalizeLocation(locStr) {
    if (!locStr) return '';
    return locStr.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}
function areLocationsNearby(locA, locB) {
    const cleanA = normalizeLocation(locA);
    const cleanB = normalizeLocation(locB);
    if (!cleanA ||!cleanB) return false;
    if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;
    for (const zone in LOCATION_ZONES) {
        const members = LOCATION_ZONES[zone];
        const aInZone = members.some(m => cleanA.includes(m));
        const bInZone = members.some(m => cleanB.includes(m));
        if (aInZone && bInZone) return true;
    }
    return false;
}

// --- COUNTDOWN & SORTING HELPERS ---
function getCountdownText(rideTimeStr, rideDateStr) {
    const now = getNairobiNow();
    const targetDate = rideDateStr? new Date(rideDateStr) : new Date(now);
    if (rideTimeStr && rideTimeStr!== 'now' && rideTimeStr!== 'Flexible') {
        const [h, m] = rideTimeStr.split(':').map(Number);
        if (!isNaN(h)) targetDate.setHours(h, m || 0, 0, 0);
    }
    const diffMs = targetDate.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / (1000 * 60));
    if (diffMins <= 0 && diffMins > -15) return 'NOW';
    if (diffMins <= -15) return 'OVERDUE';
    if (diffMins < 60) return `in ${diffMins}m`;
    const diffHours = Math.floor(diffMins / 60);
    const remMins = diffMins % 60;
    return `in ${diffHours}h${remMins}m`;
}
function sortAndTagRides(rides) {
    const now = getNairobiNow();
    return rides.map(ride => {
        let departureDate = ride.date? new Date(ride.date) : new Date(now);
        if (ride.time && ride.time!== 'now' && ride.time!== 'Flexible') {
            const [h, m] = ride.time.split(':').map(Number);
            if (!isNaN(h)) departureDate.setHours(h, m || 0, 0, 0);
        }
        const diffMins = Math.round((departureDate.getTime() - now.getTime()) / (1000 * 60));
        const isUrgent = diffMins >= -10 && diffMins <= 30;
        return {...ride, diffMins, isUrgent, countdownStr: getCountdownText(ride.time, ride.date) };
    }).sort((a, b) => {
        if (a.isUrgent &&!b.isUrgent) return -1;
        if (!a.isUrgent && b.isUrgent) return 1;
        return a.diffMins - b.diffMins;
    });
}

// --- GENERAL HELPERS ---
function normalizePhone(jid) {
    if (!jid) return '';
    let num = jid.split('@')[0].replace(/[^0-9]/g, '');
    if (num.startsWith('0')) num = '254' + num.slice(1);
    if (!num.startsWith('254') && num.length === 9) num = '254' + num;
    return num;
}
function getSession(phone) {
    if (!userSessions[phone]) userSessions[phone] = { draft: {}, lastUpdated: Date.now() };
    return userSessions[phone];
}
function clearSession(phone) { delete userSessions[phone]; }
function killChatFor(phone) {
    const norm = normalizePhone(phone);
    const keys = Object.keys(activeChats);
    for (let k of keys) {
        let normK = normalizePhone(k);
        let normWith = normalizePhone(activeChats[k]?.with);
        if (normK === norm || normWith === norm) {
            let other = activeChats[k]?.with;
            delete activeChats[k];
            if (other) delete activeChats[other];
        }
    }
}
function getNairobiNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })); }
function getTimeGreeting() {
    const h = getNairobiNow().getHours();
    if (h >= 5 && h < 12) return "Good morning";
    if (h >= 12 && h < 15) return "Good afternoon";
    if (h >= 15 && h < 19) return "Good evening";
    return "Hello";
}
function getNextWeekday(targetDay) {
    const now = getNairobiNow();
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    let target = days.indexOf(targetDay.toLowerCase());
    if (target === -1) return null;
    let result = new Date(now);
    let diff = target - now.getDay();
    if (diff <= 0) diff += 7;
    result.setDate(now.getDate() + diff);
    return result.toISOString().split('T')[0];
}
function getRealDate(aiDate) {
    if (!aiDate) return getNairobiNow().toISOString().split('T')[0];
    const now = getNairobiNow();
    const s = aiDate.toString().toLowerCase().trim();
    if (s.includes('day after tomorrow')) { let t = new Date(now); t.setDate(now.getDate()+2); return t.toISOString().split('T')[0]; }
    if (s.includes('tomorrow')) { let t = new Date(now); t.setDate(now.getDate()+1); return t.toISOString().split('T')[0]; }
    if (s.includes('next week')) { let t = new Date(now); t.setDate(now.getDate()+7); return t.toISOString().split('T')[0]; }
    if (s.includes('today') || s.includes('now') || s.includes('asap') || s==='null') return now.toISOString().split('T')[0];
    const weekdays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    for (let d of weekdays) {
        if (s.includes(d)) {
            if (s.includes('this')) {
                let target = weekdays.indexOf(d);
                let today = now.getDay();
                let jsTarget = target === 6? 0 : target+1;
                let diff = jsTarget - today;
                if (diff < 0) diff += 7;
                let result = new Date(now); result.setDate(now.getDate()+diff);
                return result.toISOString().split('T')[0];
            }
            return getNextWeekday(d);
        }
    }
    if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
    if (s.length > 25) return getNairobiNow().toISOString().split('T')[0];
    return s;
}
function getRealTime(aiTime) {
    const now = getNairobiNow();
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    if (!aiTime) return `${hh}:${mm}`;
    let l = aiTime.toString().toLowerCase().trim();
    if (['now','asap'].includes(l)) return `${hh}:${mm}`;
    let m = l.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (m) { let h=parseInt(m[1]); let min=parseInt(m[2]||'0'); let ap=m[3]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`; }
    return `${hh}:${mm}`;
}
// FIXED HERE - was \vert{}\vert{}
function toDisplayTime(t) {
    if (!t || t==='Flexible') return 'now';
    let parts = t.split(':');
    let h = parseInt(parts[0]);
    let m = parseInt(parts[1] || '0');
    if (isNaN(h)) return t;
    let ap = h>=12?'PM':'AM';
    let hh = h%12||12;
    return `${hh}:${String(m || 0).padStart(2,'0')} ${ap}`;
}
function toDisplayDate(d) {
    if (!d) return '';
    const ld = d.toLowerCase();
    if (ld.includes('next week')) return 'Next week';
    if (ld.includes('invalid')) return 'Next week';
    if (ld.includes('who') || ld.includes('what') || ld.includes('where') || ld.includes('okay')) return 'Today';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const now = getNairobiNow();
    const today = now.toISOString().split('T')[0];
    let tom = new Date(now); tom.setDate(now.getDate()+1);
    const tomorrow = tom.toISOString().split('T')[0];
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    let date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-US',{weekday:'short'});
}
function getDirectChatLink(jid) {
    let num = normalizePhone(jid);
    return `https://wa.me/${num}`;
}
function parseRating(txt) {
    const t = txt.toLowerCase().trim();
    if (/^[1-5]$/.test(t)) return parseInt(t, 10);
    let m = t.match(/\b([1-5])\b/);
    if (m) return parseInt(m[1], 10);
    return null;
}
async function addRatingToUser(phone, newRating) {
    try {
        let fresh = await User.getOrCreate(phone);
        let countBefore = fresh.ratingCount || 0;
        let avgBefore = fresh.rating || 5;
        if (countBefore === 0) {
            fresh.rating = newRating;
            fresh.ratingCount = 1;
        } else {
            fresh.rating = (avgBefore * countBefore + newRating) / (countBefore + 1);
            fresh.ratingCount = countBefore + 1;
        }
        await fresh.save();
        console.log(`RATING SAVED: ${phone} rated ${newRating}, new avg ${fresh.rating.toFixed(1)} count ${fresh.ratingCount}`);
        return fresh.rating;
    } catch(e) { console.error("Rating save error:", e.stack); return 5; }
}
function isPollutedRide(r) {
    let f = (r.from||'').toLowerCase();
    let t = (r.to||'').toLowerCase();
    let d = (r.date||'').toLowerCase();
    let bad = ['where','who','what','when','why','how','president','amazon','founder','kenya is','usa is','okay','where is','is kenya','is the','filter','yooh','end','next','available'];
    if (bad.some(b => f.includes(b) || t.includes(b) || d.includes(b))) return true;
    if (f.length<2 || t.length<2 || f.length>20 || t.length>20) return true;
    return false;
}
async function sendGupshupMessage(toJid, txt) {
    if (!toJid ||!sock) return;
    try { let jid = toJid.includes('@')? toJid : toJid.replace('+','').trim()+'@s.whatsapp.net'; await sock.sendMessage(jid, { text: txt }); } catch(e) { console.error(e.message); }
}
async function sendRidesList(toJid, rides, title="RIDES:", page=0) {
    if (!rides || rides.length === 0) {
        await sendGupshupMessage(toJid, `${title}\nNo rides now. Try FILTER Juja or CLEAR`);
        return;
    }
    let cleanRides = rides.filter(r =>!isPollutedRide(r));
    if (cleanRides.length === 0) {
        await sendGupshupMessage(toJid, `No valid rides. Try CLEAR FILTERS`);
        return;
    }
    const sortedRides = sortAndTagRides(cleanRides.map(r => r.dataValues || r));
    const PAGE_SIZE = 10;
    const start = page * PAGE_SIZE;
    const chunk = sortedRides.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(sortedRides.length / PAGE_SIZE);
    if (chunk.length === 0) {
        await sendGupshupMessage(toJid, `End of list. Type NEXT to start over`);
        return;
    }
    let header = `*${title.toUpperCase()} (${sortedRides.length}) P${page + 1}/${totalPages}*\n`;
    let lines = [];
    for (let r of chunk) {
        let from = (r.from || 'Juja').split(',')[0].split(' ')[0].substring(0, 12);
        let to = (r.to || 'Thika').split(',')[0].split(' ')[0].substring(0, 12);
        from = from.charAt(0).toUpperCase() + from.slice(1).toLowerCase();
        to = to.charAt(0).toUpperCase() + to.slice(1).toLowerCase();
        let timeStr = toDisplayTime(r.time);
        let rate = '5.0';
        let cnt = 0;
        try { let u = await User.getOrCreate(r.phone); rate = (u.rating || 5).toFixed(1); cnt = u.ratingCount || 0; } catch(e) {}
        let urgentTag = r.isUrgent? `[URGENT] ` : ``;
        lines.push(`${urgentTag}${r.id}. ${from} -> ${to} (${timeStr} | ${r.countdownStr}) Rating: ${rate} ⭐ (${cnt})`);
    }
    let footer = `\nReply ID e.g. ${chunk[0].id}\n`;
    if (totalPages > 1 && page < totalPages - 1) footer += `NEXT for more | FILTER city`;
    else footer += `FILTER city | CLEAR`;
    let sess = getSession(toJid);
    sess.ridesList = sortedRides;
    sess.ridesPage = page;
    sess.lastTitle = title;
    await sendGupshupMessage(toJid, header + lines.join('\n') + footer);
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
        await sendGupshupMessage(other, `${sender} ${chat.rideId}: ${text}`);
        await sendGupshupMessage(phoneJid, `Sent to ${receiver}`);
        return true;
    } catch(e) { return false; }
}
async function answerGeneralQuestion(q, loc="Juja") {
    const lower = q.toLowerCase().trim();
    if (!lower || lower.length <= 2) return null;
    if (/^\d+$/.test(lower)) return null;
    if (['thanks','thank you','thankyou','asante','asante sana','thx'].includes(lower)) return "You're welcome!";
    if (lower.startsWith('okay') || ['ok','okay','sawa','poa','cool','nice','great','alright'].includes(lower)) return "Got it!";
    if (['hi','hey','hello','niaje','mambo','hii','heyy','yo'].includes(lower)) return `${getTimeGreeting()}! I'm Bett - I help students with rides.`;
    if (lower.includes('who are you') || lower.includes('what are you')) return "I'm Bett! I help students in Kenya connect with affordable rides.";
    if (lower.includes('is there any driver') || lower.includes('any drivers') || lower.includes('are there drivers')) {
        return "Yes, we have drivers online! If you need a ride, just say Need a ride and tell me where from and where to. If you're a driver, say 'I want to offer ride from X to Y' to set your route.";
    }
    if (lower.includes('help') || lower.includes('what can you do') || lower.includes('how does it work')) {
        return "I'm Bett! I connect students who need rides with drivers. Riders: Say 'Need a ride' and tell me your route and time. Drivers: Say 'Need to offer ride' or 'I want to offer ride from Juja to Thika' to go online and see matching rides. Reply with ride ID to take.";
    }
    try {
        let sys = `You are Bett, a friendly knowledgeable assistant. Rules: Answer in clear correct English, perfect complete answer in 2-4 sentences, informative not too short, full context with dates/location, Do NOT say "Juja to Thika", No emojis, Location: ${loc}`;
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b",
            messages: [{role:"system",content:sys},{role:"user",content:q}],
            temperature:0.4, max_tokens: 250
        }, { headers:{ "Authorization":`Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch(e) { return null; }
}
var SYSTEM_PROMPT = `You are Bett, an AI student ride-sharing assistant in Kenya.
Current Context:
- Date/Time: {TODAY_INFO} [{TODAY_DATE}]
- Greeting: {GREETING}
- Active User Draft Session: {CONTEXT_DRAFT}
CLASSIFICATION RULES:
1. "rider": User NEEDS/WANTS a ride (e.g., "Need a ride", "taking a cab to Thika", "who is going to Juja now?", "need ride ASAP", "from Juja to Thika", "denton to dallas").
   - CRITICAL: If Active User Draft Session has "role": "rider" or "role": "driver", map isolated place names (e.g., "Denton", "Dallas", "Houston", "Thika") or time answers to missing "from", "to", or "time" fields. NEVER classify single-word slot responses as "chat".
2. "driver": User OWNS/OFFERS a ride or vehicle (e.g., "giving ride now", "ride available", "driving to Thika", "offering 3 seats from Juja", "car ready", "leaving Juja shortly", "I want to offer ride").
3. "command": Precise action flags like ONLINE, OFFLINE, SHOW_REQUESTS, CLEAR_FILTERS, NEXT, TAKE [ID], FILTER [Location], END_RIDE.
4. "chat": General knowledge questions, greetings, or off-topic queries ONLY when NOT responding to an active draft prompt.
Extraction Requirements:
- If session draft lacks "from", extract a location input as "from".
- If session draft has "from" but lacks "to", extract a location input as "to".
- Resolve relative dates/times to structured values ("now", "tomorrow", "HH:MM", "YYYY-MM-DD").
Return ONLY a JSON object:
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
async function parseWithAI(msg, contextDraft = {}) {
    var now = getNairobiNow();
    var todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0] + " " + now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
    var greeting = getTimeGreeting();
    var prompt = SYSTEM_PROMPT.replace("{TODAY_INFO}", todayInfo).replace("{TODAY_DATE}", now.toISOString().split('T')[0]).replace("{GREETING}", greeting).replace("{CONTEXT_DRAFT}", JSON.stringify(contextDraft));
    var apiKey = process.env.GROQ_API_KEY;
    var models = ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"];
    for (var i = 0; i < models.length; i++) {
        try {
            var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
                { model: models[i], messages: [{ role: "system", content: prompt },{ role: "user", content: msg }], temperature: 0.1, response_format: { type: "json_object" } },
                { headers: { "Authorization": `Bearer ${apiKey}` } }
            );
            var data = JSON.parse(res.data.choices[0].message.content.trim());
            if (data.date) data.date = getRealDate(data.date);
            if (data.time) data.time = getRealTime(data.time);
            return data;
        } catch (e) {
            if (i === models.length - 1) { console.error("AI Parsing Failure:", e.message); return { role: "chat" }; }
        }
    }
}
async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        if (lowerText.length < 1) return;
        const userPhoneKey = realPhone || phoneJid;
        const normKey = normalizePhone(userPhoneKey);
        let ratingSess = ratingSessions[userPhoneKey] || ratingSessions[normKey] || ratingSessions[phoneJid];
        if (ratingSess) {
            let rate = parseRating(lowerText);
            if (rate) {
                let otherTarget = ratingSess.other;
                let rideId = ratingSess.rideId;
                let newAvg = await addRatingToUser(otherTarget, rate);
                delete ratingSessions[userPhoneKey];
                delete ratingSessions[normKey];
                delete ratingSessions[phoneJid];
                delete ratingSessions[normalizePhone(otherTarget)];
                await sendGupshupMessage(phoneJid, `Rating saved! You rated ${rate} ⭐ for trip ${rideId}. New avg for them: ${newAvg.toFixed(1)} ⭐\n\nNeed another? Say: Need a ride`);
                try {
                    let otherUser = await User.getOrCreate(otherTarget);
                    await sendGupshupMessage(otherTarget, `You received ${rate} ⭐ for trip ${rideId}! Your new avg: ${otherUser.rating.toFixed(1)} ⭐ (${otherUser.ratingCount||0})`);
                } catch(e){}
                return;
            } else if (lowerText.includes('skip') || lowerText === 'no') {
                delete ratingSessions[userPhoneKey];
                delete ratingSessions[normKey];
                delete ratingSessions[phoneJid];
                await sendGupshupMessage(phoneJid, "Skipped rating. Need another? Say: Need a ride");
                return;
            } else {
                await sendGupshupMessage(phoneJid, `Please rate 1-5 stars for trip ${ratingSess.rideId}. Example: 5 or type skip`);
                return;
            }
        }
        if (activeChats[userPhoneKey] || activeChats[normKey]) {
            const isControlCmd = ['end ride','end trip','complete','done','finish'].some(c => lowerText.includes(c));
            if (!isControlCmd && await checkAndForwardChat(phoneJid, text, realPhone)) return;
        }
        if (/^\d+$/.test(lowerText) || lowerText.startsWith('take ')) {
            let rideId = parseInt(lowerText.replace(/[^0-9]/g, ''), 10);
            if (rideId) {
                let ride = await RideRequest.findByPk(rideId);
                if (!ride) { await sendGupshupMessage(phoneJid, `Ride ${rideId} not found. Try ONLINE`); return; }
                if (normalizePhone(ride.phone) === normKey) { await sendGupshupMessage(phoneJid, `You can't take your own ride ${rideId}`); return; }
                if (ride.status === 'OPEN') {
                    ride.status = 'TAKEN'; ride.driverPhone = userPhoneKey; await ride.save();
                    activeChats[ride.phone] = { with: userPhoneKey, rideId: ride.id };
                    activeChats[userPhoneKey] = { with: ride.phone, rideId: ride.id };
                    activeChats[normKey] = { with: ride.phone, rideId: ride.id };
                    let rider = await User.getOrCreate(ride.phone);
                    let driver = await User.getOrCreate(userPhoneKey);
                    await sendGupshupMessage(phoneJid, `MATCHED ${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\nRider: ${getDirectChatLink(ride.phone)} | Rating: ${(rider.rating||5).toFixed(1)} ⭐ (${rider.ratingCount||0})\nYour rating: ${(driver.rating||5).toFixed(1)} ⭐ (${driver.ratingCount||0})\nEND RIDE when done`);
                    await sendGupshupMessage(ride.phone, `DRIVER FOUND ${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${getDirectChatLink(userPhoneKey)} | Rating: ${(driver.rating||5).toFixed(1)} ⭐ (${driver.ratingCount||0})\nYour rating: ${(rider.rating||5).toFixed(1)} ⭐ (${rider.ratingCount||0})`);
                    return;
                } else { await sendGupshupMessage(phoneJid, `Ride ${rideId} already taken`); return; }
            }
        }
        if (lowerText === 'next' || lowerText === 'more' || lowerText === 'next page') {
            let s = getSession(userPhoneKey);
            if (s.ridesList && s.ridesList.length > 0) {
                let nextPage = (s.ridesPage || 0) + 1;
                let totalPages = Math.ceil(s.ridesList.length / 10);
                if (nextPage >= totalPages) nextPage = 0;
                await sendRidesList(phoneJid, s.ridesList, s.lastTitle || 'RIDES:', nextPage);
                return;
            } else { await sendGupshupMessage(phoneJid, `No list active. Say ONLINE to see rides.`); return; }
        }
        let currentSess = getSession(userPhoneKey);
        let ai = await parseWithAI(text, currentSess.draft || {});
        if (ai.role === 'driver') {
            let draft = currentSess.draft || {};
            let from = ai.from || draft.from;
            let to = ai.to || draft.to;
            if (!from) {
                currentSess.draft = { role: 'driver' };
                await sendGupshupMessage(phoneJid, `Great! You want to offer a ride.\nWhere are you driving from? Example: Denton or Juja`);
                return;
            }
            currentSess.draft.from = from;
            if (from &&!to) {
                currentSess.draft = { role: 'driver', from: from };
                await sendGupshupMessage(phoneJid, `Got it, driving from ${from} -- where to? Example: Dallas or Thika`);
                return;
            }
            currentSess.draft.to = to;
            let u = await User.getOrCreate(userPhoneKey);
            await u.setOnline(from, 2);
            u.filterFrom = from;
            await u.save();
            let allRides = await RideRequest.findAll({ where: { status: 'OPEN' } });
            let matched = allRides.filter(r => { if (isPollutedRide(r)) return false; return areLocationsNearby(from, r.from) || areLocationsNearby(to, r.to); });
            let ridesToShow = matched.length > 0? matched : allRides;
            await sendGupshupMessage(phoneJid, `ONLINE AS DRIVER: ${from} -> ${to} | Rating: ${(u.rating||5).toFixed(1)} ⭐ (${u.ratingCount||0}) | ${ridesToShow.length} matching`);
            await sendRidesList(phoneJid, ridesToShow, `${ridesToShow.length} RIDES MATCHING ${from.toUpperCase()} -> ${to.toUpperCase()}:`, 0);
            clearSession(userPhoneKey);
            let s = getSession(userPhoneKey); s.ridesList = ridesToShow;
            return;
        }
        if (ai.role === 'rider') {
            let draft = currentSess.draft || {};
            let from = ai.from || draft.from;
            let to = ai.to || draft.to;
            let time = ai.time || draft.time;
            let date = ai.date || draft.date || getRealDate('today');
            if (!from) {
                currentSess.draft = { role: 'rider' };
                await sendGupshupMessage(phoneJid, `Got it! Where are you riding from? Example: Denton or Juja`);
                return;
            }
            currentSess.draft.from = from;
            if (from &&!to) {
                currentSess.draft = { role: 'rider', from: from };
                await sendGupshupMessage(phoneJid, `Got it, from ${from} -- where to?`);
                return;
            }
            currentSess.draft.to = to;
            if (from && to &&!time) {
                currentSess.draft = { role: 'rider', from: from, to: to, date: date };
                await sendGupshupMessage(phoneJid, `Got it, ${from} -> ${to}. What time? Reply Now or 9 AM`);
                return;
            }
            currentSess.draft.time = time;
            let rideReq = await RideRequest.createCustom(userPhoneKey, { from, to, time, date });
            let dispDate = toDisplayDate(date);
            await sendGupshupMessage(phoneJid, `RIDE ${rideReq.id} CREATED\n${rideReq.from} -> ${rideReq.to} ${toDisplayTime(rideReq.time)} ${dispDate}\nAlerting drivers...`);
            var drivers = await User.findAll({ where: { isOnline: true } });
            var filteredDrivers = drivers.filter(d => { if (normalizePhone(d.phone || '') === normKey) return false; return!d.location || areLocationsNearby(d.location, rideReq.from) || areLocationsNearby(d.location, rideReq.to); });
            for (let d of filteredDrivers) { await sendGupshupMessage(d.phone, `NEW RIDE MATCH: ${rideReq.id}. ${rideReq.from} -> ${rideReq.to} | ${toDisplayTime(rideReq.time)} ${dispDate}\nReply ${rideReq.id}`); }
            clearSession(userPhoneKey);
            return;
        }
        if (ai.role === 'command' || ai.command) {
            if (ai.command === 'END_RIDE' || lowerText.includes('end ride') || lowerText.includes('complete trip')) {
                let rideToRate = await RideRequest.findOne({ where: { status: 'TAKEN', [Op.or]: [{ phone: userPhoneKey }, { driverPhone: userPhoneKey }, { phone: normKey }, { driverPhone: normKey }] }, order: [['updatedAt', 'DESC']] });
                if (rideToRate) { rideToRate.status = 'COMPLETED'; await rideToRate.save(); }
                let otherPhone = null;
                let activeChat = activeChats[userPhoneKey] || activeChats[normKey];
                if (activeChat) otherPhone = activeChat.with;
                else if (rideToRate) otherPhone = normalizePhone(rideToRate.phone) === normKey? rideToRate.driverPhone : rideToRate.phone;
                killChatFor(userPhoneKey); clearSession(userPhoneKey);
                if (rideToRate && otherPhone) {
                    let normOther = normalizePhone(otherPhone);
                    ratingSessions[userPhoneKey] = { rideId: rideToRate.id, other: otherPhone };
                    ratingSessions[normKey] = { rideId: rideToRate.id, other: otherPhone };
                    ratingSessions[otherPhone] = { rideId: rideToRate.id, other: userPhoneKey };
                    ratingSessions[normOther] = { rideId: rideToRate.id, other: userPhoneKey };
                    await sendGupshupMessage(phoneJid, `Trip ${rideToRate.id} ended. Thanks for riding with Bett!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)\nExample: 5`);
                    await sendGupshupMessage(otherPhone, `Trip ${rideToRate.id} ended. Thanks for riding with Bett!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)\nExample: 5`);
                } else { await sendGupshupMessage(phoneJid, "Trip ended. Chat closed.\nNeed another? Say: Need a ride"); }
                return;
            }
            if (ai.command === 'OFFLINE') { let u = await User.getOrCreate(userPhoneKey); await u.setOffline(); clearSession(userPhoneKey); delete ratingSessions[userPhoneKey]; delete ratingSessions[normKey]; await sendGupshupMessage(phoneJid, `OFFLINE - ${getTimeGreeting()}!`); return; }
            if (ai.command === 'ONLINE') {
                let parts = text.trim().split(/\s+/);
                let requestedLoc = ai.filter || (parts.length > 1? parts.slice(1).join(' ') : null);
                let u = await User.getOrCreate(userPhoneKey);
                let driverLoc = requestedLoc || u.location || "Juja";
                await u.setOnline(driverLoc, 2);
                let allRides = await RideRequest.findAll({ where: { status: 'OPEN' } });
                let nearby = allRides.filter(r => { if (isPollutedRide(r)) return false; return areLocationsNearby(driverLoc, r.from) || areLocationsNearby(driverLoc, r.to); });
                let displayRides = nearby.length > 0? nearby : allRides;
                await sendGupshupMessage(phoneJid, `ONLINE: ${driverLoc} | Rating: ${(u.rating||5).toFixed(1)} ⭐ (${u.ratingCount||0})`);
                await sendRidesList(phoneJid, displayRides, `${displayRides.length} RIDES NEAR ${driverLoc.toUpperCase()}:`);
                return;
            }
            if (ai.command === 'CLEAR_FILTERS') {
                let u = await User.getOrCreate(userPhoneKey);
                u.filterFrom = null; await u.save();
                let nearby = await RideRequest.findAll({ where: { status: 'OPEN' } });
                await sendRidesList(phoneJid, nearby, `Filters cleared - ${nearby.length} RIDES:`, 0);
                return;
            }
            if (ai.command === 'SHOW_REQUESTS') {
                let nearby = await RideRequest.findAll({ where: { status: 'OPEN' } });
                await sendRidesList(phoneJid, nearby, `${nearby.length} OPEN RIDES:`);
                return;
            }
        }
        let reply = await answerGeneralQuestion(text, (currentSess.draft && currentSess.draft.from) || "Juja");
        if (!reply) reply = `${getTimeGreeting()}! I'm Bett -- I help students with rides.`;
        await sendGupshupMessage(phoneJid, reply);
    } catch (err) { console.error('Error in handleRideLogic:', err.stack || err.message); }
}
async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ["Bett", "Chrome", "1.0"], shouldSyncHistoryMessage: () => false, syncFullHistory: false, markOnlineOnConnect: false, getMessage: async () => undefined });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrLast = qr;
        if (connection === 'open') { console.log('WA Connected'); qrLast = null; }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            qrLast = null; sock = null;
            if (code === DisconnectReason.loggedOut || code === 401) { if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true }); }
            setTimeout(startWhatsApp, 5000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages?.[0]) return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const remoteJid = msg.key.remoteJid || "";
            if (remoteJid === 'status@broadcast' || remoteJid.includes('@g.us')) return;
            let text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            if (msg.message.buttonsResponseMessage) text = msg.message.buttonsResponseMessage.selectedButtonId || "";
            if (msg.message.templateButtonReplyMessage) text = msg.message.templateButtonReplyMessage.selectedId || "";
            if (msg.message.listResponseMessage) text = msg.message.listResponseMessage.singleSelectReply?.selectedRowId || "";
            if (!text) return;
            let realPhone = remoteJid;
            if (remoteJid.includes('@lid')) {
                if (msg.key.participant &&!msg.key.participant.includes('@lid')) realPhone = msg.key.participant;
                else if (msg.key.remoteJidAlt &&!msg.key.remoteJidAlt.includes('@lid')) realPhone = msg.key.remoteJidAlt;
            }
            console.log(`MSG ${realPhone}: ${text}`);
            await handleRideLogic(remoteJid, text, realPhone);
        } catch(e) { if (e.message?.includes('Bad MAC')) return; console.error(e.message); }
    });
}
startWhatsApp();
setInterval(async () => { try { if (RideRequest.clearExpired) await RideRequest.clearExpired(); } catch(e){} }, 15 * 60 * 1000);
app.get('/qr', (req, res) => { if (!qrLast) return res.send("<h1>Connected!</h1>"); var qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qrLast); res.send(`<h1>Scan</h1><img src='${qrImage}'/>`); });
app.get('/ping', (req, res) => { res.send("Alive"); });
app.get('/', (req, res) => { res.send("Bett LIVE - Student Rides - /qr"); });
app.get('/clearall', async (req, res) => {
    await RideRequest.destroy({ where: {} });
    await RideOffer.destroy({ where: {} });
    for (let k in activeChats) delete activeChats[k];
    for (let k in userSessions) delete userSessions[k];
    for (let k in ratingSessions) delete ratingSessions[k];
    res.send("All rides deleted + memory cleared");
});
app.get('/cleardb', async (req, res) => { await sequelize.sync({ force: true }); res.send("Full DB wiped"); });
app.get('/ratings', async (req, res) => {
    let users = await User.findAll();
    res.json(users.map(u => ({ phone: u.phone, rating: u.rating, count: u.ratingCount })));
});
var PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log("Bett Running on " + PORT); });
