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

// --- DYNAMIC REGION & TIMEZONE DETECTION ---
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
    return new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
}
function getTimeGreeting(timezone) {
    if (timezone === undefined) timezone = 'America/Chicago';
    const h = getUserNow(timezone).getHours();
    if (h >= 5 && h < 12) return "Good morning";
    if (h >= 12 && h < 15) return "Good afternoon";
    if (h >= 15 && h < 19) return "Good evening";
    return "Hello";
}
function getCountdownText(rideTimeStr, rideDateStr, timezone) {
    const now = getUserNow(timezone);
    const targetDate = rideDateStr? new Date(rideDateStr) : new Date(now);
    if (rideTimeStr && rideTimeStr!== 'now' && rideTimeStr!== 'Flexible') {
        const parts = rideTimeStr.split(':');
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1] || '0', 10);
        if (!isNaN(h)) targetDate.setHours(h, m || 0, 0, 0);
    }
    const diffMs = targetDate.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / (1000 * 60));
    if (diffMins <= 0 && diffMins > -15) return 'NOW';
    if (diffMins <= -15) return 'OVERDUE';
    if (diffMins < 60) return 'in ' + diffMins + 'm';
    const diffHours = Math.floor(diffMins / 60);
    const remMins = diffMins % 60;
    return 'in ' + diffHours + 'h' + remMins + 'm';
}
function sortAndTagRides(rides, timezone) {
    const now = getUserNow(timezone);
    return rides.map(ride => {
        let departureDate = ride.date? new Date(ride.date) : new Date(now);
        if (ride.time && ride.time!== 'now' && ride.time!== 'Flexible') {
            const parts = String(ride.time).split(':');
            const h = parseInt(parts[0], 10);
            const m = parseInt(parts[1] || '0', 10);
            if (!isNaN(h)) departureDate.setHours(h, m || 0, 0, 0);
        }
        const diffMins = Math.round((departureDate.getTime() - now.getTime()) / (1000 * 60));
        const isUrgent = diffMins >= -10 && diffMins <= 30;
        return {...ride, diffMins, isUrgent, countdownStr: getCountdownText(ride.time, ride.date, timezone) };
    }).sort((a, b) => {
        if (a.isUrgent &&!b.isUrgent) return -1;
        if (!a.isUrgent && b.isUrgent) return 1;
        return a.diffMins - b.diffMins;
    });
}
function normalizePhone(jid) {
    if (!jid) return '';
    return jid.split('@')[0].replace(/[^0-9]/g, '');
}
function getSession(phone) {
    if (!userSessions[phone]) userSessions[phone] = { draft: {}, lastUpdated: Date.now() };
    return userSessions[phone];
}
function clearSession(phone) { delete userSessions[phone]; }
function killChatFor(phone) {
    const norm = normalizePhone(phone);
    for (let k of Object.keys(activeChats)) {
        let normK = normalizePhone(k);
        let normWith = normalizePhone(activeChats[k] && activeChats[k].with? activeChats[k].with : '');
        if (normK === norm || normWith === norm) {
            let other = activeChats[k] && activeChats[k].with? activeChats[k].with : null;
            delete activeChats[k];
            if (other) delete activeChats[other];
        }
    }
}
function getNextWeekday(targetDay, timezone) {
    const now = getUserNow(timezone);
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    let target = days.indexOf(targetDay.toLowerCase());
    if (target === -1) return null;
    let result = new Date(now);
    let diff = target - now.getDay();
    if (diff <= 0) diff += 7;
    result.setDate(now.getDate() + diff);
    return result.toISOString().split('T')[0];
}
function getRealDate(aiDate, timezone) {
    const now = getUserNow(timezone);
    if (!aiDate) return now.toISOString().split('T')[0];
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
            return getNextWeekday(d, timezone);
        }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return now.toISOString().split('T')[0];
}
function getRealTime(aiTime, timezone) {
    const now = getUserNow(timezone);
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    if (!aiTime) return hh + ':' + mm;
    let l = aiTime.toString().toLowerCase().trim();
    if (['now','asap'].includes(l)) return hh + ':' + mm;
    let m = l.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (m) {
        let h = parseInt(m[1], 10);
        let min = parseInt(m[2] || '0', 10);
        let ap = m[3];
        if (ap==='pm' && h<12) h += 12;
        if (ap==='am' && h===12) h = 0;
        return String(h).padStart(2,'0') + ':' + String(min).padStart(2,'0');
    }
    return hh + ':' + mm;
}
function toDisplayTime(t) {
    if (!t || t === 'Flexible') return 'now';
    let parts = String(t).split(':');
    let h = parseInt(parts[0], 10);
    let m = parseInt(parts[1] || '0', 10);
    if (isNaN(h)) return t;
    let ap = h >= 12? 'PM' : 'AM';
    let hh = h % 12 || 12;
    return hh + ':' + String(m || 0).padStart(2, '0') + ' ' + ap;
}
function toDisplayDate(d, timezone) {
    if (!d) return '';
    const ld = d.toLowerCase();
    if (ld.includes('next week')) return 'Next week';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const now = getUserNow(timezone);
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
    return 'https://wa.me/' + num;
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
async function sendGupshupMessage(toJid, txt) {
    if (!toJid ||!sock) return;
    try {
        let jid = toJid.includes('@')? toJid : toJid.replace('+','').trim()+'@s.whatsapp.net';
        await sock.sendMessage(jid, { text: txt });
    } catch(e) { console.error(e.message); }
}
async function sendRidesList(toJid, rides, title, page, timezone) {
    if (title === undefined) title = "RIDES:";
    if (page === undefined) page = 0;
    if (timezone === undefined) timezone = 'America/Chicago';
    if (!rides || rides.length === 0) {
        await sendGupshupMessage(toJid, title + "\nNo rides found right now. Try FILTER [City] or CLEAR");
        return;
    }
    let cleanRides = rides.filter(r =>!isPollutedRide(r));
    let seenPhones = new Set();
    cleanRides = cleanRides.filter(r => {
        let p = normalizePhone(r.phone);
        if (seenPhones.has(p)) return false;
        seenPhones.add(p);
        return true;
    });
    if (cleanRides.length === 0) {
        await sendGupshupMessage(toJid, "No valid rides. Try CLEAR FILTERS");
        return;
    }
    const sortedRides = sortAndTagRides(cleanRides.map(r => r.dataValues || r), timezone);
    const PAGE_SIZE = 10;
    const start = page * PAGE_SIZE;
    const chunk = sortedRides.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(sortedRides.length / PAGE_SIZE);
    if (chunk.length === 0) {
        await sendGupshupMessage(toJid, "End of list. Type NEXT to start over");
        return;
    }
    let header = '*' + title.toUpperCase() + ' (' + sortedRides.length + ') P' + (page + 1) + '/' + totalPages + '*\n';
    let lines = [];
    for (let r of chunk) {
        let from = (r.from || 'Origin').split(',')[0].split(' ')[0].substring(0, 14);
        let to = (r.to || 'Destination').split(',')[0].split(' ')[0].substring(0, 14);
        from = from.charAt(0).toUpperCase() + from.slice(1).toLowerCase();
        to = to.charAt(0).toUpperCase() + to.slice(1).toLowerCase();
        let rate = '5.0';
        let cnt = 0;
        try { let u = await User.getOrCreate(r.phone); rate = (u.rating || 5).toFixed(1); cnt = u.ratingCount || 0; } catch(e) {}
        let urgentIcon = r.isUrgent? '🔴 ' : '';
        lines.push(urgentIcon + r.id + '. ' + from + '→' + to + ' • ' + r.countdownStr + ' • ' + rate + '⭐(' + cnt + ')');
    }
    let footer = "\nReply ID e.g. " + chunk[0].id + "\n";
    if (totalPages > 1 && page < totalPages - 1) footer += "NEXT for more | FILTER city";
    else footer += "FILTER city | CLEAR";
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
    if (['hi','hey','hello','hii','heyy','yo'].includes(lower)) return greeting + "! I'm Bett - I help students with rides.";
    if (lower.includes('who are you') || lower.includes('what are you')) return "I'm Bett! I help students connect with affordable rides near campus.";
    try {
        let sys = 'You are Bett, a friendly ride assistant. Rules: Answer in clear English, 2-3 sentences max, relevant to location ' + (loc || region.defaultCity) + ' in ' + region.country + '. No emojis.';
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b",
            messages: [{role:"system",content:sys},{role:"user",content:q}],
            temperature:0.4, max_tokens: 200
        }, { headers:{ "Authorization":`Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch(e) { return null; }
}
var SYSTEM_PROMPT = `You are Bett, an AI student ride-sharing assistant operating in {COUNTRY}.
Current Context:
- Local Time: {TODAY_INFO} [{TODAY_DATE}]
- Active Draft Session: {CONTEXT_DRAFT}
CLASSIFICATION RULES:
1. "rider": User NEEDS/WANTS a ride (e.g., "Need a ride", "taking a cab", "need ride ASAP", "from A to B").
   - Map isolated place names or times to missing "from", "to", or "time" fields in active drafts.
2. "driver": User OWNS/OFFERS a ride or vehicle (e.g., "giving ride now", "driving to X", "offering seats", "I want to offer ride").
3. "command": Action flags like ONLINE, OFFLINE, SHOW_REQUESTS, CLEAR_FILTERS, NEXT, TAKE [ID], FILTER [Location], END_RIDE.
4. "chat": Greetings or general queries when NOT filling a ride draft.
Return ONLY JSON:
{
  "role": "rider" | "driver" | "command" | "chat",
  "command": "ONLINE" | "OFFLINE" | "SHOW_REQUESTS" | "TAKE" | "FILTER" | "CLEAR_FILTERS" | "NEXT" | "END_RIDE" | null,
  "filter": string | null,
  "takeId": number | null,
  "from": string | null,
  "to": string | null,
  "date": string | null,
  "time": string | null
}`;
async function parseWithAI(msg, region, contextDraft) {
    if (contextDraft === undefined) contextDraft = {};
    var now = getUserNow(region.timezone);
    var todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0] + " " + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    var prompt = SYSTEM_PROMPT.replace("{COUNTRY}", region.country).replace("{TODAY_INFO}", todayInfo).replace("{TODAY_DATE}", now.toISOString().split('T')[0]).replace("{CONTEXT_DRAFT}", JSON.stringify(contextDraft));
    var apiKey = process.env.GROQ_API_KEY;
    var models = ["llama-3.3-70b-versatile", "openai/gpt-oss-20b"];
    for (var i = 0; i < models.length; i++) {
        try {
            var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
                { model: models[i], messages: [{ role: "system", content: prompt },{ role: "user", content: msg }], temperature: 0.1, response_format: { type: "json_object" } },
                { headers: { "Authorization": "Bearer " + apiKey } }
            );
            var data = JSON.parse(res.data.choices[0].message.content.trim());
            if (data.date) data.date = getRealDate(data.date, region.timezone);
            if (data.time) data.time = getRealTime(data.time, region.timezone);
            return data;
        } catch (e) {
            if (i === models.length - 1) return { role: "chat" };
        }
    }
}

// --- MAIN LOGIC WITH FALLBACK FIX ---
async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        if (lowerText.length < 1) return;
        const userPhoneKey = realPhone || phoneJid;
        const normKey = normalizePhone(userPhoneKey);
        const region = detectUserRegion(userPhoneKey);
        const rawText = text.trim();

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
                await sendGupshupMessage(phoneJid, 'Rating saved! You rated ' + rate + ' ⭐ for trip ' + rideId + '. New avg for them: ' + newAvg.toFixed(1) + ' ⭐\n\nNeed another? Say: Need a ride');
                return;
            } else if (lowerText.includes('skip') || lowerText === 'no') {
                delete ratingSessions[userPhoneKey];
                delete ratingSessions[normKey];
                delete ratingSessions[phoneJid];
                await sendGupshupMessage(phoneJid, "Skipped rating. Need another? Say: Need a ride");
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
                if (!ride) { await sendGupshupMessage(phoneJid, 'Ride ' + rideId + ' not found. Try ONLINE'); return; }
                if (normalizePhone(ride.phone) === normKey) { await sendGupshupMessage(phoneJid, "You can't take your own ride " + rideId); return; }
                if (ride.status === 'OPEN') {
                    ride.status = 'TAKEN'; ride.driverPhone = userPhoneKey; await ride.save();
                    activeChats[ride.phone] = { with: userPhoneKey, rideId: ride.id };
                    activeChats[userPhoneKey] = { with: ride.phone, rideId: ride.id };
                    activeChats[normKey] = { with: ride.phone, rideId: ride.id };
                    let rider = await User.getOrCreate(ride.phone);
                    await sendGupshupMessage(phoneJid, 'MATCHED ' + ride.id + ' ' + ride.from + ' -> ' + ride.to + ' ' + toDisplayTime(ride.time) + '\nRider: ' + getDirectChatLink(ride.phone) + ' | Rating: ' + (rider.rating||5).toFixed(1) + ' ⭐\nEND RIDE when done');
                    await sendGupshupMessage(ride.phone, 'DRIVER FOUND ' + ride.id + ' ' + ride.from + ' -> ' + ride.to + '\nDriver: ' + getDirectChatLink(userPhoneKey) + ' | Rating: ' + ((await User.getOrCreate(userPhoneKey)).rating||5).toFixed(1) + ' ⭐');
                    return;
                } else { await sendGupshupMessage(phoneJid, 'Ride ' + rideId + ' already taken'); return; }
            }
        }

        if (lowerText === 'next' || lowerText === 'more' || lowerText === 'next page') {
            let s = getSession(userPhoneKey);
            if (s.ridesList && s.ridesList.length > 0) {
                let nextPage = (s.ridesPage || 0) + 1;
                let totalPages = Math.ceil(s.ridesList.length / 10);
                if (nextPage >= totalPages) nextPage = 0;
                await sendRidesList(phoneJid, s.ridesList, s.lastTitle || 'RIDES:', nextPage, region.timezone);
                return;
            } else { await sendGupshupMessage(phoneJid, "No list active. Say ONLINE to see rides."); return; }
        }

        let currentSess = getSession(userPhoneKey);
        let ai = await parseWithAI(text, region, currentSess.draft || {});

        // --- DRIVER WITH FALLBACK ---
        if (ai.role === 'driver') {
            let draft = currentSess.draft || {};
            // FALLBACK: use raw text as location if AI missed it
            let from = ai.from || draft.from;
            if (!from && rawText.length >= 3 && rawText.length <= 30 &&!['online','offline','clear','next','hey','hi','hello','ok'].includes(lowerText)) {
                from = rawText;
            }
            let to = ai.to || draft.to;
            // If draft already has from, and user sends new word, treat as to
            if (draft.from &&!ai.to &&!to && rawText.toLowerCase()!== draft.from.toLowerCase() && rawText.length >=3) {
                if (!['kericho','juja','ruiru','thika','nairobi','denton','dallas','frisco'].includes(lowerText) || true) {
                    // Only if from exists, raw is to
                    if (from && draft.from) to = rawText;
                }
            }

            if (!from) {
                currentSess.draft = { role: 'driver' };
                await sendGupshupMessage(phoneJid, 'Where are you driving from? Example: ' + region.examplePlaces);
                return;
            }
            currentSess.draft.from = from;
            if (from &&!to) {
                currentSess.draft = { role: 'driver', from: from };
                await sendGupshupMessage(phoneJid, 'Got it, driving from ' + from + ' -- where to? Example: ' + region.exampleDest);
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
            await sendGupshupMessage(phoneJid, 'ONLINE AS DRIVER: ' + from + ' -> ' + to + ' | Rating: ' + (u.rating||5).toFixed(1) + ' ⭐ (' + (u.ratingCount||0) + ') | ' + ridesToShow.length + ' matching');
            await sendRidesList(phoneJid, ridesToShow, ridesToShow.length + ' RIDES MATCHING ' + from.toUpperCase() + ' -> ' + to.toUpperCase() + ':', 0, region.timezone);
            clearSession(userPhoneKey);
            let s = getSession(userPhoneKey); s.ridesList = ridesToShow;
            return;
        }

        // --- RIDER WITH FALLBACK - FIXES YOUR SCREENSHOT LOOP ---
        if (ai.role === 'rider') {
            let draft = currentSess.draft || {};
            let from = ai.from || draft.from;
            let to = ai.to || draft.to;
            let time = ai.time || draft.time;
            let date = ai.date || draft.date || getRealDate('today', region.timezone);

            // CRITICAL FALLBACK: If AI returns null but user typed a place like Kericho/Juja, use it
            if (!from && rawText.length >= 3 && rawText.length <= 30) {
                const blacklist = ['need a ride','want ride','need ride','i need','online','offline','clear','next','hi','hey','hello','thanks'];
                if (!blacklist.some(b => lowerText.includes(b))) {
                    from = rawText;
                }
            }
            if (from &&!to && draft.from) {
                // Second message after from is to
                if (rawText.toLowerCase()!== draft.from.toLowerCase() && rawText.length >=3 && rawText.length <=30) {
                    const blacklist2 = ['now','asap','morning','afternoon','evening','today','tomorrow'];
                    if (!blacklist2.includes(lowerText)) {
                        to = rawText;
                    }
                }
            }

            if (!from) {
                currentSess.draft = { role: 'rider' };
                await sendGupshupMessage(phoneJid, 'Where are you riding from? Example: ' + region.examplePlaces);
                return;
            }
            currentSess.draft.from = from;
            if (from &&!to) {
                currentSess.draft = { role: 'rider', from: from };
                await sendGupshupMessage(phoneJid, 'Got it, from ' + from + ' -- where to? Example: ' + region.exampleDest);
                return;
            }
            currentSess.draft.to = to;
            if (from && to &&!time) {
                currentSess.draft = { role: 'rider', from: from, to: to, date: date };
                await sendGupshupMessage(phoneJid, 'Got it, ' + from + ' -> ' + to + '. What time? Reply Now or 9 AM');
                return;
            }
            currentSess.draft.time = time;
            let rideReq = await RideRequest.createCustom(userPhoneKey, { from, to, time, date });
            let dispDate = toDisplayDate(date, region.timezone);
            await sendGupshupMessage(phoneJid, 'RIDE ' + rideReq.id + ' CREATED\n' + rideReq.from + ' -> ' + rideReq.to + ' ' + toDisplayTime(rideReq.time) + ' ' + dispDate + '\nAlerting drivers...');
            var drivers = await User.findAll({ where: { isOnline: true } });
            var filteredDrivers = drivers.filter(d => { if (normalizePhone(d.phone || '') === normKey) return false; return!d.location || areLocationsNearby(d.location, rideReq.from) || areLocationsNearby(d.location, rideReq.to); });
            for (let d of filteredDrivers) { await sendGupshupMessage(d.phone, 'NEW RIDE MATCH: ' + rideReq.id + '. ' + rideReq.from + ' -> ' + rideReq.to + ' | ' + toDisplayTime(rideReq.time) + ' ' + dispDate + '\nReply ' + rideReq.id); }
            clearSession(userPhoneKey);
            return;
        }

        if (ai.role === 'command' || ai.command) {
            if (ai.command === 'END_RIDE' || lowerText.includes('end ride') || lowerText.includes('complete trip') || lowerText === 'end' || lowerText === 'end this ride') {
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
                    await sendGupshupMessage(phoneJid, 'Trip ' + rideToRate.id + ' ended. Thanks for riding with Bett!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)');
                    await sendGupshupMessage(otherPhone, 'Trip ' + rideToRate.id + ' ended. Thanks for riding with Bett!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)');
                } else { await sendGupshupMessage(phoneJid, "Trip ended. Chat closed.\nNeed another? Say: Need a ride"); }
                return;
            }
            if (ai.command === 'OFFLINE') { let u = await User.getOrCreate(userPhoneKey); await u.setOffline(); clearSession(userPhoneKey); delete ratingSessions[userPhoneKey]; delete ratingSessions[normKey]; await sendGupshupMessage(phoneJid, 'OFFLINE - ' + getTimeGreeting(region.timezone) + '!'); return; }
            if (ai.command === 'ONLINE') {
                let parts = text.trim().split(/\s+/);
                let requestedLoc = ai.filter || (parts.length > 1? parts.slice(1).join(' ') : null);
                let u = await User.getOrCreate(userPhoneKey);
                let driverLoc = requestedLoc || u.location || region.defaultCity;
                await u.setOnline(driverLoc, 2);
                let allRides = await RideRequest.findAll({ where: { status: 'OPEN' } });
                let nearby = allRides.filter(r => { if (isPollutedRide(r)) return false; return areLocationsNearby(driverLoc, r.from) || areLocationsNearby(driverLoc, r.to); });
                let displayRides = nearby.length > 0? nearby : allRides;
                await sendGupshupMessage(phoneJid, 'ONLINE: ' + driverLoc + ' | Rating: ' + (u.rating||5).toFixed(1) + ' ⭐ (' + (u.ratingCount||0) + ')');
                await sendRidesList(phoneJid, displayRides, displayRides.length + ' RIDES NEAR ' + driverLoc.toUpperCase() + ':', 0, region.timezone);
                return;
            }
            if (ai.command === 'CLEAR_FILTERS') {
                let u = await User.getOrCreate(userPhoneKey);
                u.filterFrom = null; await u.save();
                let nearby = await RideRequest.findAll({ where: { status: 'OPEN' } });
                await sendRidesList(phoneJid, nearby, 'Filters cleared - ' + nearby.length + ' RIDES:', 0, region.timezone);
                return;
            }
            if (ai.command === 'SHOW_REQUESTS') {
                let nearby = await RideRequest.findAll({ where: { status: 'OPEN' } });
                await sendRidesList(phoneJid, nearby, nearby.length + ' OPEN RIDES:', 0, region.timezone);
                return;
            }
        }

        let reply = await answerGeneralQuestion(text, region, (currentSess.draft && currentSess.draft.from));
        if (!reply) reply = getTimeGreeting(region.timezone) + "! I'm Bett -- I help students with rides.";
        await sendGupshupMessage(phoneJid, reply);
    } catch (err) { console.error('Error in handleRideLogic:', err.stack || err.message); }
}

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ["Bett Universal", "Chrome", "1.0"], shouldSyncHistoryMessage: () => false, syncFullHistory: false, markOnlineOnConnect: false, getMessage: async () => undefined });
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
            console.log('MSG ' + realPhone + ': ' + text);
            await handleRideLogic(remoteJid, text, realPhone);
        } catch(e) { if (e.message && e.message.includes('Bad MAC')) return; console.error(e.message); }
    });
}

startWhatsApp();
setInterval(async () => { try { if (RideRequest.clearExpired) await RideRequest.clearExpired(); } catch(e){} }, 15 * 60 * 1000);
app.get('/qr', (req, res) => { if (!qrLast) return res.send("<h1>Connected!</h1>"); var qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qrLast); res.send('<h1>Scan</h1><img src=\'' + qrImage + '\'/>'); });
app.get('/ping', (req, res) => { res.send("Alive"); });
app.get('/', (req, res) => { res.send("Bett LIVE - Dynamic Rides - /qr"); });
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
