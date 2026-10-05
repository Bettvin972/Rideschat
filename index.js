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

sequelize.sync({ alter: true })
    .then(() => console.log("DB Synced"))
    .catch(e => console.error("DB Sync Error:", e.message));

// Helper fallbacks for standard Sequelize instances
if (!User.getOrCreate) {
    User.getOrCreate = async function(phone) {
        const norm = normalizePhone(phone);
        let [user] = await User.findOrCreate({
            where: { phone: norm },
            defaults: { phone: norm, rating: 5.0, ratingCount: 0 }
        });
        return user;
    };
}

if (!User.prototype.setOnline) {
    User.prototype.setOnline = async function(location, radius = 2) {
        this.isOnline = true;
        this.location = location;
        return await this.save();
    };
}

if (!User.prototype.setOffline) {
    User.prototype.setOffline = async function() {
        this.isOnline = false;
        return await this.save();
    };
}

if (!RideRequest.createCustom) {
    RideRequest.createCustom = async function(phone, data) {
        return await RideRequest.create({
            phone: normalizePhone(phone),
            from: data.from,
            to: data.to,
            time: data.time,
            date: data.date,
            status: 'OPEN'
        });
    };
}

let sock = null;
let qrLast = null;
const AUTH_PATH = path.join(__dirname, 'auth_info');
const userSessions = {};
const activeChats = {};
const ratingSessions = {};

function detectUserRegion(jid) {
    const rawDigits = (jid || '').split('@')[0].replace(/[^0-9]/g, '');
    if (rawDigits.startsWith('1') || (rawDigits.length === 10 && !rawDigits.startsWith('0'))) {
        return { country: 'US', timezone: 'America/Chicago', defaultCity: 'Denton', defaultDestination: 'Dallas', examplePlaces: 'Denton or Frisco', exampleDest: 'Dallas or Fort Worth' };
    }
    if (rawDigits.startsWith('254') || (rawDigits.startsWith('0') && rawDigits.length === 10)) {
        return { country: 'KE', timezone: 'Africa/Nairobi', defaultCity: 'Juja', defaultDestination: 'Nairobi', examplePlaces: 'Juja or Ruiru', exampleDest: 'Thika or Nairobi' };
    }
    return { country: 'US', timezone: 'America/Chicago', defaultCity: 'Main Campus', defaultDestination: 'Downtown', examplePlaces: 'Campus or North Side', exampleDest: 'Downtown or Station' };
}

function normalizePhone(jid) {
    if (!jid) return '';
    return jid.split('@')[0].replace(/[^0-9]/g, '');
}

function getSession(phone) {
    const norm = normalizePhone(phone);
    if (!userSessions[norm]) userSessions[norm] = { draft: {}, lastUpdated: Date.now() };
    return userSessions[norm];
}

function clearSession(phone) { 
    delete userSessions[normalizePhone(phone)]; 
}

function killChatFor(phone) {
    const norm = normalizePhone(phone);
    for (let k of Object.keys(activeChats)) {
        let normK = normalizePhone(k);
        let normWith = normalizePhone(activeChats[k] && activeChats[k].with ? activeChats[k].with : '');
        if (normK === norm || normWith === norm) {
            let other = activeChats[k] && activeChats[k].with ? activeChats[k].with : null;
            delete activeChats[k];
            if (other) delete activeChats[other];
        }
    }
}

function normalizeLocation(locStr) {
    if (!locStr) return '';
    return locStr.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function areLocationsNearby(locA, locB) {
    const cleanA = normalizeLocation(locA);
    const cleanB = normalizeLocation(locB);
    if (!cleanA || !cleanB) return false;
    if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;
    const wordsA = cleanA.split(/\s+/);
    const wordsB = cleanB.split(/\s+/);
    return wordsA.some(w => w.length > 3 && wordsB.includes(w));
}

function getUserNow(timezone) {
    return new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
}

function getTimeGreeting(timezone = 'Africa/Nairobi') {
    const h = getUserNow(timezone).getHours();
    if (h >= 5 && h < 12) return "Good morning";
    if (h >= 12 && h < 15) return "Good afternoon";
    if (h >= 15 && h < 19) return "Good evening";
    return "Hello";
}

function getCountdownText(rideTimeStr, rideDateStr, timezone) {
    const now = getUserNow(timezone);
    if (!rideTimeStr || rideTimeStr === 'now' || rideTimeStr === 'Flexible') return 'NOW';
    const parts = String(rideTimeStr).split(':');
    let h = parseInt(parts[0], 10);
    let m = parseInt(parts[1] || '0', 10);
    if (isNaN(h)) return 'NOW';
    let target = new Date(now);
    if (rideDateStr && /^\d{4}-\d{2}-\d{2}$/.test(rideDateStr)) {
        let [yy, mm, dd] = rideDateStr.split('-').map(Number);
        target.setFullYear(yy, mm - 1, dd);
    }
    target.setHours(h, m || 0, 0, 0);
    const diffMs = target.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / (1000 * 60));
    if (diffMins <= 0 && diffMins > -30) return 'NOW';
    if (diffMins <= -30) return 'OVERDUE';
    if (diffMins < 60) return `in ${diffMins}m`;
    const diffHours = Math.floor(diffMins / 60);
    const remMins = diffMins % 60;
    return `in ${diffHours}h${remMins > 0 ? remMins + 'm' : ''}`;
}

function sortAndTagRides(rides, timezone) {
    const now = getUserNow(timezone);
    return rides.map(ride => {
        let target = new Date(now);
        if (ride.date && /^\d{4}-\d{2}-\d{2}$/.test(ride.date)) {
            let [yy, mm, dd] = ride.date.split('-').map(Number);
            target.setFullYear(yy, mm - 1, dd);
        }
        if (ride.time && ride.time !== 'now' && ride.time !== 'Flexible') {
            const parts = String(ride.time).split(':');
            const h = parseInt(parts[0], 10);
            const m = parseInt(parts[1] || '0', 10);
            if (!isNaN(h)) target.setHours(h, m || 0, 0, 0);
        }
        const diffMins = Math.round((target.getTime() - now.getTime()) / (1000 * 60));
        const isUrgent = diffMins >= -30 && diffMins <= 60;
        return { ...ride, diffMins, isUrgent, countdownStr: getCountdownText(ride.time, ride.date, timezone) };
    }).sort((a, b) => {
        if (a.isUrgent && !b.isUrgent) return -1;
        if (!a.isUrgent && b.isUrgent) return 1;
        return a.diffMins - b.diffMins;
    });
}

function getNextWeekday(targetDay, timezone) {
    const now = getUserNow(timezone);
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
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
    if (s.includes('day after tomorrow')) { let t = new Date(now); t.setDate(now.getDate() + 2); return t.toISOString().split('T')[0]; }
    if (s.includes('tomorrow')) { let t = new Date(now); t.setDate(now.getDate() + 1); return t.toISOString().split('T')[0]; }
    if (s.includes('next week')) { let t = new Date(now); t.setDate(now.getDate() + 7); return t.toISOString().split('T')[0]; }
    if (s.includes('today') || s.includes('now') || s.includes('asap') || s === 'null') return now.toISOString().split('T')[0];
    const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (let d of weekdays) {
        if (s.includes(d)) {
            return getNextWeekday(d, timezone);
        }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return now.toISOString().split('T')[0];
}

function getRealTime(aiTime, timezone) {
    if (!aiTime) return null;
    const now = getUserNow(timezone);
    let l = aiTime.toString().toLowerCase().trim();
    const wordMap = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12' };
    for (let w in wordMap) { l = l.replace(new RegExp(`\\b${w}\\b`, 'g'), wordMap[w]); }
    if (['now', 'asap', 'flexible', 'just now', 'immediately', 'now now'].includes(l)) {
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        return `${hh}:${mm}`;
    }
    if (l.includes('morning')) return '09:00';
    if (l.includes('afternoon')) return '14:00';
    if (l.includes('evening') || l.includes('tonight')) return '19:00';
    let m = l.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (m) {
        let h = parseInt(m[1], 10);
        let min = parseInt(m[2] || '0', 10);
        let ap = m[3];
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (h >= 0 && h <= 23 && min >= 0 && min < 60) {
            return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        }
    }
    return null;
}

function toDisplayTime(t) {
    if (!t || t === 'Flexible') return 'now';
    let parts = String(t).split(':');
    let h = parseInt(parts[0], 10);
    let m = parseInt(parts[1] || '0', 10);
    if (isNaN(h)) return t;
    let ap = h >= 12 ? 'PM' : 'AM';
    let hh = h % 12 || 12;
    return hh + ':' + String(m || 0).padStart(2, '0') + ' ' + ap;
}

function toDisplayDate(d, timezone) {
    if (!d) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const now = getUserNow(timezone);
    const today = now.toISOString().split('T')[0];
    let tom = new Date(now); tom.setDate(now.getDate() + 1);
    const tomorrow = tom.toISOString().split('T')[0];
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    let date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-US', { weekday: 'short' });
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
    } catch (e) { return 5; }
}

async function sendGupshupMessage(toJid, txt) {
    if (!toJid || !sock) return;
    try {
        let jid = toJid.includes('@') ? toJid : normalizePhone(toJid) + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: txt });
    } catch (e) { console.error('Send error:', e.message); }
}

async function sendRidesList(toJid, rides, title = "RIDES:", page = 0, timezone = 'Africa/Nairobi') {
    if (!rides || rides.length === 0) {
        await sendGupshupMessage(toJid, "No rides right now.\nSay FILTER Nairobi or CLEAR");
        return;
    }
    const sortedRides = sortAndTagRides(rides.map(r => r.dataValues || r), timezone);
    const PAGE_SIZE = 10;
    const start = page * PAGE_SIZE;
    const chunk = sortedRides.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(sortedRides.length / PAGE_SIZE);
    
    let lines = [];
    for (let r of chunk) {
        let from = (r.from || '').split(',')[0].trim().substring(0, 16);
        let to = (r.to || '').split(',')[0].trim().substring(0, 16);
        from = from.charAt(0).toUpperCase() + from.slice(1);
        to = to.charAt(0).toUpperCase() + to.slice(1);
        let rate = '5.0';
        try { let u = await User.getOrCreate(r.phone); rate = (u.rating || 5).toFixed(1); } catch (e) {}
        lines.push(`${r.id}. ${from}→${to} • ${r.countdownStr} • ${rate}★`);
    }
    let header = sortedRides.length === 1 
        ? `${sortedRides.length} ride - reply with ID:\n` 
        : `${sortedRides.length} rides - reply with ID - P${page + 1}/${totalPages}:\n`;
        
    let firstId = chunk[0].id;
    let footer = (totalPages > 1 && page < totalPages - 1)
        ? `\nReply with ID e.g. ${firstId} or NEXT`
        : `\nReply with ID e.g. ${firstId}`;

    let sess = getSession(toJid);
    sess.ridesList = sortedRides;
    sess.ridesPage = page;
    sess.lastTitle = title;
    await sendGupshupMessage(toJid, header + lines.join('\n') + footer);
}

async function checkAndForwardChat(phoneJid, text, realPhone) {
    const userPhoneKey = normalizePhone(realPhone || phoneJid);
    let chat = activeChats[userPhoneKey];
    if (!chat) return false;
    try {
        let ride = await RideRequest.findByPk(chat.rideId);
        if (!ride || ride.status !== 'TAKEN') { killChatFor(userPhoneKey); return false; }
        let other = chat.with;
        let sender = normalizePhone(ride.phone) === userPhoneKey ? "Rider" : "Driver";
        let receiver = sender === "Rider" ? "driver" : "rider";
        await sendGupshupMessage(other, sender + ' ' + chat.rideId + ': ' + text);
        await sendGupshupMessage(phoneJid, 'Sent to ' + receiver);
        return true;
    } catch (e) { return false; }
}

async function answerGeneralQuestion(q) {
    try {
        let sys = 'You are Induu, a helpful AI assistant for ride sharing. Answer the general knowledge or conversational question clearly and concisely (1-2 sentences max).';
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "llama-3.3-70b-versatile",
            messages: [{ role: "system", content: sys }, { role: "user", content: q }],
            temperature: 0.3, max_tokens: 150
        }, { headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch (e) { 
        return "Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip."; 
    }
}

// Strictly-governed LLM Intent Classification Prompt
var SYSTEM_PROMPT = `You are the intent parser for Induu, an AI student ride-sharing assistant operating in {COUNTRY}.
Local Time: {TODAY_INFO} [{TODAY_DATE}]
Active Draft Session State: {CONTEXT_DRAFT}

CLASSIFICATION & EXTRACTION LAWS:
1. "rider": User expresses intent to get or request a ride (e.g. "I need a ride", "Want a ride", "take a cab", "going to Nairobi"). 
   - CRITICAL: Intent statements without specific locations like "I need a ride", "Want a ride", "Need ride" MUST set "from": null and "to": null. NEVER extract intent phrases as locations!
   - If the active session draft is missing a "from" or "to" location, and the user input is a single place or phrase (e.g. "Bypass", "Juja", "Kikuyu"), extract that place accurately into the missing slot ("from" or "to").

2. "driver": User offers or gives a ride (e.g. "Want to give ride", "driving to Nairobi", "I am a driver").
   - CRITICAL: Phrases like "Want to give ride", "give ride" MUST set "from": null and "to": null unless explicit origins/destinations are stated.

3. "command": Precise control commands: ONLINE, OFFLINE, SHOW_REQUESTS, CLEAR_FILTERS, NEXT, TAKE [ID], FILTER [Location], END_RIDE.

4. "chat": General knowledge, questions (e.g., "Who was president of Kenya in 2001?"), greetings ("Hi", "Hello"), or out-of-topic remarks.

Return ONLY JSON:
{
  "role": "rider" | "driver" | "command" | "chat",
  "command": "ONLINE" | "OFFLINE" | "SHOW_REQUESTS" | "TAKE" | "FILTER" | "CLEAR_FILTERS" | "NEXT" | "END_RIDE" | null,
  "filter": string | null,
  "from": string | null,
  "to": string | null,
  "date": string | null,
  "time": string | null
}`;

async function parseWithAI(msg, region, contextDraft = {}) {
    var now = getUserNow(region.timezone);
    var todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0] + " " + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    var prompt = SYSTEM_PROMPT.replace("{COUNTRY}", region.country).replace("{TODAY_INFO}", todayInfo).replace("{TODAY_DATE}", now.toISOString().split('T')[0]).replace("{CONTEXT_DRAFT}", JSON.stringify(contextDraft));
    var apiKey = process.env.GROQ_API_KEY;

    try {
        var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
            { 
                model: "llama-3.3-70b-versatile", 
                messages: [{ role: "system", content: prompt }, { role: "user", content: msg }], 
                temperature: 0.1, 
                response_format: { type: "json_object" } 
            },
            { headers: { "Authorization": "Bearer " + apiKey } }
        );
        var data = JSON.parse(res.data.choices[0].message.content.trim());
        if (data.date) { data.date = getRealDate(data.date, region.timezone); } else { data.date = null; }
        if (data.time) { data.time = getRealTime(data.time, region.timezone); } else { data.time = null; }
        return data;
    } catch (e) {
        return { role: "chat" };
    }
}

async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        if (lowerText.length < 1) return;
        const userPhoneKey = realPhone || phoneJid;
        const normKey = normalizePhone(userPhoneKey);
        const region = detectUserRegion(userPhoneKey);

        // Rating flow
        let ratingSess = ratingSessions[normKey];
        if (ratingSess) {
            let rate = parseRating(lowerText);
            if (rate) {
                let otherTarget = ratingSess.other;
                let rideId = ratingSess.rideId;
                let newAvg = await addRatingToUser(otherTarget, rate);
                delete ratingSessions[normKey];
                delete ratingSessions[normalizePhone(otherTarget)];
                await sendGupshupMessage(phoneJid, 'Rating saved! You rated ' + rate + ' ★ for trip ' + rideId + '. New avg: ' + newAvg.toFixed(1) + ' ★\n\nNeed another? Say: Need a ride');
                return;
            } else if (lowerText.includes('skip') || lowerText === 'no') {
                delete ratingSessions[normKey];
                await sendGupshupMessage(phoneJid, "Skipped rating. Need another? Say: Need a ride");
                return;
            }
        }

        // Active match messaging flow
        if (activeChats[normKey]) {
            const isControlCmd = ['end ride', 'end trip', 'complete', 'done', 'finish'].some(c => lowerText.includes(c));
            if (!isControlCmd && await checkAndForwardChat(phoneJid, text, realPhone)) return;
        }

        // Reset stale drafts on fresh request triggers
        if (['i need a ride', 'want a ride', 'need ride', 'want to give ride', 'give ride', 'i am driving'].some(p => lowerText === p || lowerText.startsWith(p))) {
            clearSession(userPhoneKey);
        }

        let currentSess = getSession(userPhoneKey);
        let ai = await parseWithAI(text, region, currentSess.draft || {});

        // Direct Ride Acceptance by ID
        if (/^\d+$/.test(lowerText) || lowerText.startsWith('take ')) {
            let rideId = parseInt(lowerText.replace(/[^0-9]/g, ''), 10);
            if (rideId) {
                let ride = await RideRequest.findByPk(rideId);
                if (!ride) { await sendGupshupMessage(phoneJid, 'Ride ' + rideId + ' not found. Try ONLINE'); return; }
                if (normalizePhone(ride.phone) === normKey) { await sendGupshupMessage(phoneJid, "You can't take your own ride " + rideId); return; }
                if (ride.status === 'OPEN') {
                    ride.status = 'TAKEN'; ride.driverPhone = userPhoneKey; await ride.save();
                    activeChats[normalizePhone(ride.phone)] = { with: userPhoneKey, rideId: ride.id };
                    activeChats[normKey] = { with: ride.phone, rideId: ride.id };
                    
                    let rider = await User.getOrCreate(ride.phone);
                    await sendGupshupMessage(phoneJid, 'MATCHED ' + ride.id + ' ' + ride.from + ' -> ' + ride.to + ' ' + toDisplayTime(ride.time) + '\nRider: ' + getDirectChatLink(ride.phone) + ' | Rating: ' + (rider.rating || 5).toFixed(1) + ' ★\nEND RIDE when done');
                    await sendGupshupMessage(ride.phone, 'DRIVER FOUND ' + ride.id + ' ' + ride.from + ' -> ' + ride.to + '\nDriver: ' + getDirectChatLink(userPhoneKey) + ' | Rating: ' + ((await User.getOrCreate(userPhoneKey)).rating || 5).toFixed(1) + ' ★');
                    return;
                } else { await sendGupshupMessage(phoneJid, 'Ride ' + rideId + ' already taken'); return; }
            }
        }

        // Driver Flow
        if (ai.role === 'driver') {
            let draft = currentSess.draft || {};
            let from = ai.from || draft.from || null;
            let to = ai.to || draft.to || null;

            currentSess.draft.role = 'driver';

            if (!from) {
                await sendGupshupMessage(phoneJid, 'Where are you driving from? Example: ' + region.examplePlaces);
                return;
            }

            currentSess.draft.from = from;

            if (!to) {
                await sendGupshupMessage(phoneJid, 'Got it, driving from ' + from + ' -- where to? Example: ' + region.exampleDest);
                return;
            }

            if (from.toLowerCase() === to.toLowerCase()) {
                await sendGupshupMessage(phoneJid, 'From and to can\'t be the same (' + from + '). Where are you driving to?');
                currentSess.draft.to = null;
                return;
            }

            currentSess.draft.to = to;
            let u = await User.getOrCreate(userPhoneKey);
            await u.setOnline(from, 2);
            u.filterFrom = from;
            await u.save();

            let allRides = await RideRequest.findAll({ where: { status: 'OPEN' } });
            let matched = allRides.filter(r => areLocationsNearby(from, r.from) || areLocationsNearby(to, r.to));
            let ridesToShow = matched.length > 0 ? matched : allRides;

            await sendGupshupMessage(phoneJid, `You're online: ${from}→${to} • ${ridesToShow.length} ride${ridesToShow.length !== 1 ? 's' : ''}`);
            await sendRidesList(phoneJid, ridesToShow, `${ridesToShow.length} RIDES MATCHING ${from.toUpperCase()} -> ${to.toUpperCase()}:`, 0, region.timezone);
            clearSession(userPhoneKey);
            return;
        }

        // Rider Flow
        if (ai.role === 'rider') {
            let draft = currentSess.draft || {};
            let from = ai.from || draft.from || null;
            let to = ai.to || draft.to || null;
            let time = ai.time || draft.time || null;
            let date = ai.date || draft.date || null;

            currentSess.draft.role = 'rider';

            if (!from) {
                await sendGupshupMessage(phoneJid, 'Where are you riding from? Example: ' + region.examplePlaces);
                return;
            }

            currentSess.draft.from = from;

            if (!to) {
                await sendGupshupMessage(phoneJid, 'Got it, from ' + from + ' -- where to? Example: ' + region.exampleDest);
                return;
            }

            if (from.toLowerCase() === to.toLowerCase()) {
                await sendGupshupMessage(phoneJid, 'From and to can\'t be the same. Where to? Example: ' + region.exampleDest);
                currentSess.draft.to = null;
                return;
            }

            currentSess.draft.to = to;

            if (!time) {
                await sendGupshupMessage(phoneJid, 'Got it, ' + from + ' -> ' + to + '. What time?');
                return;
            }

            if (!date) date = getRealDate('today', region.timezone);
            let rideReq = await RideRequest.createCustom(userPhoneKey, { from, to, time, date });
            let dispDate = toDisplayDate(date, region.timezone);
            
            await sendGupshupMessage(phoneJid, 'RIDE ' + rideReq.id + ' CREATED\n' + rideReq.from + ' -> ' + rideReq.to + ' ' + toDisplayTime(rideReq.time) + ' ' + dispDate + '\nAlerting drivers...');
            
            var drivers = await User.findAll({ where: { isOnline: true } });
            var filteredDrivers = drivers.filter(d => { 
                if (normalizePhone(d.phone || '') === normKey) return false; 
                return !d.location || areLocationsNearby(d.location, rideReq.from) || areLocationsNearby(d.location, rideReq.to); 
            });

            for (let d of filteredDrivers) { 
                await sendGupshupMessage(d.phone, 'NEW RIDE MATCH: ' + rideReq.id + '. ' + rideReq.from + ' -> ' + rideReq.to + ' | ' + toDisplayTime(rideReq.time) + ' ' + dispDate + '\nReply ' + rideReq.id + ' to take'); 
            }
            clearSession(userPhoneKey);
            return;
        }

        // Commands
        if (ai.role === 'command' || ai.command) {
            if (ai.command === 'END_RIDE' || lowerText.includes('end ride') || lowerText === 'end') {
                let rideToRate = await RideRequest.findOne({ where: { status: 'TAKEN', [Op.or]: [{ phone: userPhoneKey }, { driverPhone: userPhoneKey }, { phone: normKey }, { driverPhone: normKey }] }, order: [['updatedAt', 'DESC']] });
                if (rideToRate) { rideToRate.status = 'COMPLETED'; await rideToRate.save(); }
                let otherPhone = null;
                let activeChat = activeChats[normKey];
                if (activeChat) otherPhone = activeChat.with;
                else if (rideToRate) otherPhone = normalizePhone(rideToRate.phone) === normKey ? rideToRate.driverPhone : rideToRate.phone;
                
                killChatFor(userPhoneKey); clearSession(userPhoneKey);
                if (rideToRate && otherPhone) {
                    let normOther = normalizePhone(otherPhone);
                    ratingSessions[normKey] = { rideId: rideToRate.id, other: otherPhone };
                    ratingSessions[normOther] = { rideId: rideToRate.id, other: userPhoneKey };
                    await sendGupshupMessage(phoneJid, 'Trip ' + rideToRate.id + ' ended. Thanks for using Induu!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)');
                    await sendGupshupMessage(otherPhone, 'Trip ' + rideToRate.id + ' ended. Thanks for using Induu!\n\nPlease rate: Reply 1-5 stars (5 = Excellent)');
                } else { 
                    await sendGupshupMessage(phoneJid, "Trip ended. Chat closed.\nNeed another? Say: Need a ride"); 
                }
                return;
            }

            if (ai.command === 'OFFLINE') { 
                let u = await User.getOrCreate(userPhoneKey); 
                await u.setOffline(); 
                clearSession(userPhoneKey); 
                delete ratingSessions[normKey]; 
                await sendGupshupMessage(phoneJid, 'OFFLINE - ' + getTimeGreeting(region.timezone) + '!'); 
                return; 
            }

            if (ai.command === 'ONLINE') {
                let u = await User.getOrCreate(userPhoneKey);
                let driverLoc = ai.filter || u.location || region.defaultCity;
                await u.setOnline(driverLoc, 2);
                let allRides = await RideRequest.findAll({ where: { status: 'OPEN' } });
                await sendGupshupMessage(phoneJid, 'ONLINE: ' + driverLoc + ' | Rating: ' + (u.rating || 5).toFixed(1) + ' ★');
                await sendRidesList(phoneJid, allRides, allRides.length + ' RIDES NEAR ' + driverLoc.toUpperCase() + ':', 0, region.timezone);
                return;
            }

            if (ai.command === 'NEXT') {
                let s = getSession(userPhoneKey);
                if (s.ridesList && s.ridesList.length > 0) {
                    let nextPage = (s.ridesPage || 0) + 1;
                    let totalPages = Math.ceil(s.ridesList.length / 10);
                    if (nextPage >= totalPages) nextPage = 0;
                    await sendRidesList(phoneJid, s.ridesList, s.lastTitle || 'RIDES:', nextPage, region.timezone);
                } else {
                    await sendGupshupMessage(phoneJid, "No list active. Say ONLINE to see rides.");
                }
                return;
            }
        }

        // Conversational AI Fallback
        let reply = await answerGeneralQuestion(text);
        await sendGupshupMessage(phoneJid, reply);

    } catch (err) { console.error('Error in handleRideLogic:', err.stack || err.message); }
}

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ 
        version, 
        auth: state, 
        logger: pino({ level: 'silent' }), 
        browser: ["Induu Universal", "Chrome", "1.0"], 
        shouldSyncHistoryMessage: () => false, 
        syncFullHistory: false, 
        markOnlineOnConnect: false, 
        getMessage: async () => undefined 
    });
    
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrLast = qr;
        if (connection === 'open') { console.log('WA Connected'); qrLast = null; }
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            qrLast = null; sock = null;
            if (code === DisconnectReason.loggedOut || code === 401) { 
                if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true }); 
            }
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
                if (msg.key.participant && !msg.key.participant.includes('@lid')) realPhone = msg.key.participant;
                else if (msg.key.remoteJidAlt && !msg.key.remoteJidAlt.includes('@lid')) realPhone = msg.key.remoteJidAlt;
            }
            console.log('MSG ' + realPhone + ': ' + text);
            await handleRideLogic(remoteJid, text, realPhone);
        } catch(e) { 
            if (e.message && e.message.includes('Bad MAC')) return; 
            console.error('Error handling message:', e.message); 
        }
    });
}

startWhatsApp();

setInterval(async () => { 
    try { 
        if (RideRequest.clearExpired) await RideRequest.clearExpired(); 
    } catch(e){} 
}, 15 * 60 * 1000);

app.get('/qr', (req, res) => { 
    if (!qrLast) return res.send("<h1>Connected!</h1>"); 
    var qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qrLast); 
    res.send('<h1>Scan</h1><img src=\'' + qrImage + '\'/>'); 
});

app.get('/ping', (req, res) => { res.send("Alive"); });
app.get('/', (req, res) => { res.send("Induu LIVE - Dynamic Rides - /qr"); });

app.get('/clearall', async (req, res) => {
    await RideRequest.destroy({ where: {} });
    await RideOffer.destroy({ where: {} });
    for (let k in activeChats) delete activeChats[k];
    for (let k in userSessions) delete userSessions[k];
    for (let k in ratingSessions) delete ratingSessions[k];
    res.send("All rides deleted + memory cleared");
});

app.get('/cleardb', async (req, res) => { 
    await sequelize.sync({ force: true }); 
    res.send("Full DB wiped"); 
});

app.get('/ratings', async (req, res) => {
    let users = await User.findAll();
    res.json(users.map(u => ({ phone: u.phone, rating: u.rating, count: u.ratingCount })));
});

var PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log("Induu Running on " + PORT); });
