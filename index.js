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
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const PORT = Number(process.env.PORT || 10000);
const AUTH_PATH = path.join(__dirname, 'auth_info');
const PAGE_SIZE = 15;
const DRIVER_ONLINE_HOURS = 2;
const MAX_SEATS = 6;
const MAX_LOCATION_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 4000;
const RECONNECT_DELAY_MS = 5000;
const EXPIRY_INTERVAL_MS = 15 * 60 * 1000;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = ['openai/gpt-oss-20b'];

let sock = null;
let qrLast = null;
let reconnectTimer = null;
let startingWhatsApp = false;
let shuttingDown = false;
let dbReady = false;
const userSessions = new Map();
const activeChats = new Map();
const ratingSessions = new Map();
const endingLocks = new Set();
const userQueues = new Map();

function logError(prefix, err) {
    const details = err?.response?.data || err?.data || err;
    console.error(prefix, details?.stack || details?.message || JSON.stringify(details) || err);
}
function normalizePhone(value) { if (!value) return ''; return String(value).split('@')[0].replace(/[^0-9]/g, ''); }
function canonicalPhone(realPhone, remoteJid) { return normalizePhone(realPhone) || normalizePhone(remoteJid); }
function getJid(phoneOrJid) { if (!phoneOrJid) return ''; if (String(phoneOrJid).includes('@')) return String(phoneOrJid); const digits = normalizePhone(phoneOrJid); return digits? `${digits}@s.whatsapp.net` : ''; }
function getDirectChatLink(jid) { const number = normalizePhone(jid); return number? `https://wa.me/${number}` : ''; }
function clampInteger(value, min, max, fallback = null) { const n = Number.parseInt(value, 10); if (!Number.isFinite(n)) return fallback; return Math.min(max, Math.max(min, n)); }
function cleanText(value, maxLength = MAX_MESSAGE_LENGTH) { return String(value || '').trim().slice(0, maxLength); }

function getSession(phone) {
    const key = normalizePhone(phone) || String(phone || '');
    if (!userSessions.has(key)) userSessions.set(key, { draft: {}, ridesList: [], ridesPage: 0, lastTitle: 'RIDES:', lastUpdated: Date.now() });
    const session = userSessions.get(key); session.lastUpdated = Date.now(); return session;
}
function clearSession(phone) { const key = normalizePhone(phone) || String(phone || ''); userSessions.delete(key); }
function queueUserMessage(phone, task) {
    const key = normalizePhone(phone) || String(phone || 'unknown');
    const previous = userQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task).catch(err => logError(`User queue error [${key}]`, err));
    userQueues.set(key, next);
    next.finally(() => { if (userQueues.get(key) === next) userQueues.delete(key); }).catch(() => {});
    return next;
}
function detectUserRegion(jid) {
    const digits = normalizePhone(jid);
    if (digits.startsWith('254') || (digits.startsWith('0') && digits.length === 10)) return { country: 'KE', timezone: 'Africa/Nairobi', defaultCity: 'Juja', defaultDestination: 'Nairobi', examplePlaces: 'Juja or Ruiru', exampleDest: 'Thika or Nairobi' };
    if (digits.startsWith('1') || (digits.length === 10 &&!digits.startsWith('0'))) return { country: 'US', timezone: 'America/Chicago', defaultCity: 'Denton', defaultDestination: 'Dallas', examplePlaces: 'Denton or Frisco', exampleDest: 'Dallas or Fort Worth' };
    return { country: 'US', timezone: 'America/Chicago', defaultCity: 'Main Campus', defaultDestination: 'Downtown', examplePlaces: 'Campus or North Side', exampleDest: 'Downtown or Station' };
}
function getLocalParts(date = new Date(), timezone = 'America/Chicago') {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    return Object.fromEntries(parts.filter(p => p.type!== 'literal').map(p => [p.type, p.value]));
}
function getLocalDateString(date = new Date(), timezone = 'America/Chicago') { const p = getLocalParts(date, timezone); return `${p.year}-${p.month}-${p.day}`; }
function getTimeGreeting(timezone) { const hour = Number(getLocalParts(new Date(), timezone).hour); if (hour >= 5 && hour < 12) return 'Good morning'; if (hour >= 12 && hour < 15) return 'Good afternoon'; if (hour >= 15 && hour < 19) return 'Good evening'; return 'Hello'; }
function addCalendarDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return d; }
function localDatePlusDays(days, timezone) { return getLocalDateString(addCalendarDays(new Date(), days), timezone); }
function getNextWeekday(targetDay, timezone) {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const target = days.indexOf(String(targetDay || '').toLowerCase()); if (target < 0) return null;
    const now = new Date(); const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(now).toLowerCase();
    const current = days.indexOf(weekday); let diff = target - current; if (diff <= 0) diff += 7; return localDatePlusDays(diff, timezone);
}
function getRealDate(aiDate, timezone) {
    const today = getLocalDateString(new Date(), timezone); if (!aiDate) return today; const s = String(aiDate).toLowerCase().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const parsed = new Date(`${s}T00:00:00Z`); if (!Number.isNaN(parsed.getTime())) return s; }
    if (s.includes('day after tomorrow')) return localDatePlusDays(2, timezone);
    if (s.includes('tomorrow')) return localDatePlusDays(1, timezone);
    if (s.includes('next week')) return localDatePlusDays(7, timezone);
    if (s.includes('today') || s.includes('now') || s.includes('asap') || s === 'null') return today;
    const weekdays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    for (const weekday of weekdays) { if (!s.includes(weekday)) continue; const date = getNextWeekday(weekday, timezone); if (!date) return today; return date; }
    return today;
}
function getRealTime(aiTime, timezone) {
    if (!aiTime) return null; let value = String(aiTime).toLowerCase().trim();
    const wordMap = { one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', ten:'10', eleven:'11', twelve:'12' };
    for (const [word, number] of Object.entries(wordMap)) value = value.replace(new RegExp(`\\b${word}\\b`, 'g'), number);
    if (['now','asap','flexible','just now','immediately','now now'].includes(value)) { const p = getLocalParts(new Date(), timezone); return `${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`; }
    if (/\b(this )?morning\b/.test(value)) return '09:00'; if (/\b(this )?afternoon\b/.test(value)) return '14:00'; if (/\b(evening|tonight)\b/.test(value)) return '19:00';
    const amPm = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (amPm) { let hour = Number(amPm[1]); const minute = Number(amPm[2] || 0); const period = amPm[3]; if (period === 'pm' && hour < 12) hour += 12; if (period === 'am' && hour === 12) hour = 0; if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null; return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`; }
    const twentyFour = value.match(/\b(\d{1,2}):(\d{2})\b/); if (twentyFour) { const hour = Number(twentyFour[1]); const minute = Number(twentyFour[2]); if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null; return `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`; }
    return null;
}
function toDisplayTime(time) { if (!time || time === 'Flexible' || time === 'now') return 'now'; const parts = String(time).split(':'); const hour = Number.parseInt(parts[0], 10); const minute = Number.parseInt(parts[1] || '0', 10); if (!Number.isFinite(hour)) return String(time); return `${hour % 12 || 12}:${String(minute).padStart(2,'0')} ${hour >= 12? 'PM' : 'AM'}`; }
function toDisplayDate(date, timezone) {
    if (!date) return ''; const value = String(date); if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const today = getLocalDateString(new Date(), timezone); const tomorrow = localDatePlusDays(1, timezone);
    if (value === today) return 'Today'; if (value === tomorrow) return 'Tomorrow';
    const parsed = new Date(`${value}T12:00:00Z`); return parsed.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function parseLocalDateTime(dateString, timeString, timezone) {
    if (!dateString ||!timeString || timeString === 'now') return null; const match = String(timeString).match(/^(\d{2}):(\d{2})$/); if (!match) return null;
    const hour = Number(match[1]); const minute = Number(match[2]); if (hour > 23 || minute > 59) return null;
    const parts = String(dateString).split('-').map(Number); if (parts.length!== 3 || parts.some(n =>!Number.isFinite(n))) return null;
    const [year, month, day] = parts; let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    for (let i = 0; i < 2; i++) { const local = getLocalParts(guess, timezone); const asUTC = Date.UTC(Number(local.year), Number(local.month)-1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second)); const wanted = Date.UTC(year, month-1, day, hour, minute, 0); guess = new Date(guess.getTime() + (wanted - asUTC)); }
    return guess;
}
function getCountdownText(rideTime, rideDate, timezone) {
    if (!rideTime || rideTime === 'now' || rideTime === 'Flexible') return 'NOW';
    const target = parseLocalDateTime(rideDate, rideTime, timezone); if (!target) return 'NOW';
    const diffMins = Math.round((target.getTime() - Date.now()) / 60000);
    if (diffMins <= 0 && diffMins > -30) return 'NOW'; if (diffMins <= -30) return 'OVERDUE';
    if (diffMins < 60) return `in ${diffMins}m`; const hours = Math.floor(diffMins/60); const minutes = diffMins % 60; return `in ${hours}h${minutes? `${minutes}m` : ''}`;
}
function sortAndTagRides(rides, timezone) {
    const now = Date.now();
    return rides.map(ride => {
        const item = ride.dataValues? {...ride.dataValues } : {...ride };
        const target = item.time && item.time!== 'now' && item.time!== 'Flexible'? parseLocalDateTime(item.date || getLocalDateString(new Date(), timezone), item.time, timezone) : new Date();
        const targetMs = target? target.getTime() : now; const diffMins = Math.round((targetMs - now)/60000);
        return {...item, diffMins, isUrgent: diffMins >= -30 && diffMins <= 60, countdownStr: getCountdownText(item.time, item.date, timezone) };
    }).sort((a,b)=>{ if (a.isUrgent &&!b.isUrgent) return -1; if (!a.isUrgent && b.isUrgent) return 1; return a.diffMins - b.diffMins; });
}
function normalizeLocation(value) { return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(); }
function locationTokens(value) { return normalizeLocation(value).split(/\s+/).filter(Boolean); }
function isValidLocation(location) {
    if (!location) return false; const value = normalizeLocation(location); if (value.length < 2 || value.length > MAX_LOCATION_LENGTH) return false;
    const invalid = ['need a ride','need ride','i need','want ride','want a ride','online','offline','hello','hi','hey','thanks','where is','what is','who is','when did','tell me','how are you'];
    return!invalid.some(x => value === x || value.includes(x));
}
function locationsEqual(a,b){ const x=normalizeLocation(a); const y=normalizeLocation(b); return!!x &&!!y && x===y; }
function areLocationsNearby(a,b){
    const x=normalizeLocation(a); const y=normalizeLocation(b); if (!x ||!y) return false; if (x===y) return true; if (x.includes(y) || y.includes(x)) return true;
    const aTokens=locationTokens(x); const bTokens=new Set(locationTokens(y));
    const stopWords=new Set(['road','street','st','rd','avenue','ave','campus','area','town','city','the','near']);
    const meaningfulA=aTokens.filter(token=>token.length>=4 &&!stopWords.has(token));
    return meaningfulA.some(token=>bTokens.has(token));
}
function routeMatches(driverFrom, driverTo, rideFrom, rideTo){
    const originMatch=areLocationsNearby(driverFrom, rideFrom)||areLocationsNearby(driverFrom, rideTo);
    const destinationMatch=areLocationsNearby(driverTo, rideTo)||areLocationsNearby(driverTo, rideFrom);
    if (areLocationsNearby(driverFrom, rideFrom) && areLocationsNearby(driverTo, rideTo)) return true;
    return originMatch && destinationMatch;
}
function isPollutedRide(ride){
    const fields=[ride?.from,ride?.to,ride?.date].filter(Boolean).map(v=>String(v).toLowerCase());
    const bad=['where','who','what','when','why','how','president','amazon','founder','okay','filter','end','next','available','tell me','what is','who is'];
    if (bad.some(word=>fields.some(field=>field.includes(word)))) return true;
    const from=String(ride?.from||'').trim(); const to=String(ride?.to||'').trim();
    return (!isValidLocation(from) ||!isValidLocation(to) || from.length>MAX_LOCATION_LENGTH || to.length>MAX_LOCATION_LENGTH);
}
function isCommandPhrase(text){
    const value=String(text||'').toLowerCase().trim(); if (!value) return true;
    const commands=['i want to give ride','give ride','want to give ride','ride available','i want to offer ride','offer ride','i am driver','online','offline','clear','next','more','hi','hello','hey','thanks','ok','okay'];
    return commands.some(command=>value===command || value.startsWith(`${command} `));
}
function parseRating(text){
    const value=String(text||'').toLowerCase().trim(); if (value.length>30) return null;
    if (/^[1-5]$/.test(value)) return Number(value);
    const stars=value.match(/^([1-5])\s*stars?$/i); if (stars) return Number(stars[1]);
    if (value.includes('skip') || value.includes('need a ride') || value.includes('from ') || value.includes('miles')) return null;
    const number=value.match(/\b([1-5])\b/); return number?Number(number[1]):null;
}
async function addRatingToUser(phone, newRating){
    const key=normalizePhone(phone); if (!key ||![1,2,3,4,5].includes(Number(newRating))) return 5;
    try{
        const user=await User.getOrCreate(key);
        const count=Math.max(0,Number(user.ratingCount||0)); const currentRating=Number.isFinite(Number(user.rating))?Number(user.rating):5;
        if (count===0){ user.rating=Number(newRating); user.ratingCount=1; } else { user.rating=((currentRating*count)+Number(newRating))/(count+1); user.ratingCount=count+1; }
        await user.save(); return Number(user.rating||5);
    } catch(err){ logError('Rating update failed',err); return 5; }
}
async function sendWhatsAppMessage(toJid, text){ if (!sock ||!toJid) return false; const jid=getJid(toJid); if (!jid) return false; try{ await sock.sendMessage(jid,{ text: cleanText(text) }); return true; } catch(err){ logError(`WhatsApp send failed [${jid}]`,err); return false; } }
function setActiveChat(phone, other, rideId){ const key=normalizePhone(phone); const otherKey=normalizePhone(other); if (!key ||!otherKey) return; activeChats.set(key,{ with: otherKey, rideId: Number(rideId) }); activeChats.set(otherKey,{ with: key, rideId: Number(rideId) }); }
function getActiveChat(phone){ return activeChats.get(normalizePhone(phone)); }
function killChatFor(phone){ const key=normalizePhone(phone); if (!key) return; const chat=activeChats.get(key); activeChats.delete(key); if (chat?.with) activeChats.delete(normalizePhone(chat.with)); }

async function sendRidesList(toJid, rides, title='RIDES:', page=0, timezone='America/Chicago'){
    const cleanRides=[]; const seenIds=new Set();
    for (const ride of rides||[]){ const item=ride.dataValues?{...ride.dataValues}:{...ride}; if (isPollutedRide(item)) continue; if (seenIds.has(item.id)) continue; seenIds.add(item.id); cleanRides.push(item); }
    if (!cleanRides.length){ await sendWhatsAppMessage(toJid,'No rides right now.\nSay ONLINE to see available rides.'); return; }
    const sorted=sortAndTagRides(cleanRides, timezone); const totalPages=Math.max(1, Math.ceil(sorted.length/PAGE_SIZE));
    let safePage=Number.isFinite(Number(page))?Number(page):0; if (safePage<0) safePage=0; if (safePage>=totalPages) safePage=0;
    const start=safePage*PAGE_SIZE; const chunk=sorted.slice(start, start+PAGE_SIZE);
    if (!chunk.length){ await sendWhatsAppMessage(toJid,'End of list. Type NEXT to restart.'); return; }
    let output=`*${sorted.length} rides* - P${safePage+1}/${totalPages}\nReply with the ride ID to take it.\n\n`;
    for (const ride of chunk){
        let rating=5; let ratingCount=0; let username=`Rider ${ride.id}`;
        try{ const user=await User.getOrCreate(ride.phone); rating=Number(user.rating||5); ratingCount=Math.max(0,Number(user.ratingCount||0)); if (user.name && String(user.name).trim().length>=2) username=String(user.name).trim(); } catch(_){}
        const from=String(ride.from||'').trim().replace(/^./,c=>c.toUpperCase()); const to=String(ride.to||'').trim().replace(/^./,c=>c.toUpperCase());
        const seats=clampInteger(ride.seats||ride.passengerCount,1,MAX_SEATS,1);
        output+=`~ ${username} • ${rating.toFixed(1)}★ (${ratingCount})\n${from} → ${to} • ${toDisplayDate(ride.date, timezone)} ${toDisplayTime(ride.time)} • ${seats} ${seats===1?'person':'people'}\nReply ${ride.id}\n\n`;
    }
    if (totalPages>1 && safePage<totalPages-1) output+=`NEXT for more | Example: ${chunk[0].id}`; else output+=`Reply with ID e.g. ${chunk[0].id}`;
    await sendWhatsAppMessage(toJid, output.trim());
    const session=getSession(toJid); session.ridesList=sorted; session.ridesPage=safePage; session.lastTitle=title;
}

async function answerGeneralQuestion(question, region, location){
    const lower=String(question||'').toLowerCase().trim(); if (!lower || lower.length<=2) return null; if (/^\d+$/.test(lower)) return null;
    if (['thanks','thank you','thankyou','thx'].includes(lower)) return "You're welcome!";
    if (['ok','okay','cool','nice','great','alright'].includes(lower)) return 'Got it!';
    if (['hi','hey','hello','hii','heyy','yo'].includes(lower)) return `${getTimeGreeting(region.timezone)}! I'm Induu - I help students with rides.`;
    if (lower.includes('who are you') || lower.includes('what are you')) return "I'm Induu! I help students connect with affordable rides near campus.";

    const apiKey=process.env.GROQ_API_KEY; if (!apiKey) return null;
    try{
        const response=await axios.post(GROQ_URL,{ model: GROQ_MODELS[0], messages:[{ role:'system', content:`You are Induu, a helpful AI assistant. Answer general knowledge questions accurately and clearly in concise English (maximum 3 sentences). Current location context: ${location||region.defaultCity}, ${region.country}. No emojis.` },{ role:'user', content: cleanText(question,1000) }], temperature:0.3, max_tokens:200 },{ headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' }, timeout:15000 });
        return response.data?.choices?.[0]?.message?.content?.trim()||null;
    } catch(err){
        console.error('answerGeneralQuestion Groq failed:', err.response?.data || err.message);
        return null;
    }
}

const SYSTEM_PROMPT=`
You are Induu, an AI student ride-sharing assistant operating in {COUNTRY}.
Current context:
- Local date/time: {TODAY_INFO}
- Today: {TODAY_DATE}
- Active draft: {CONTEXT_DRAFT}
CLASSIFICATION:
1. rider: The user NEEDS a ride. Examples: Need a ride, I need a ride from Juja to Nairobi, from Arlington to Chicago tomorrow for 2 people
2. driver: The user OFFERS a ride or is driving. Examples: I can give a ride, I'm driving from Juja to Nairobi
3. command: ONLINE, OFFLINE, SHOW_REQUESTS, CLEAR_FILTERS, NEXT, TAKE, FILTER, END_RIDE.
4. chat: Greetings, questions, thanks, general knowledge queries, or unrelated conversation.
IMPORTANT: Preserve draft info, do not invent locations, "for 2 people" = seats=2, Normalize time to HH:MM, dates to YYYY-MM-DD, "now" stays "now", "tonight"=19:00.
Return ONLY valid JSON:
{
  "role": "rider" | "driver" | "command" | "chat",
  "command": "ONLINE" | "OFFLINE" | "SHOW_REQUESTS" | "TAKE" | "FILTER" | "CLEAR_FILTERS" | "NEXT" | "END_RIDE" | null,
  "filter": string | null, "takeId": number | null, "from": string | null, "to": string | null, "date": string | null, "time": string | null, "seats": number | null
}
`;

function validateAIResult(data){
    if (!data || typeof data!=='object') return { role:'chat' };
    const allowedRoles=new Set(['rider','driver','command','chat']); const allowedCommands=new Set(['ONLINE','OFFLINE','SHOW_REQUESTS','TAKE','FILTER','CLEAR_FILTERS','NEXT','END_RIDE']);
    return { role: allowedRoles.has(data.role)?data.role:'chat', command: allowedCommands.has(data.command)?data.command:null, filter: typeof data.filter==='string'?cleanText(data.filter,MAX_LOCATION_LENGTH):null, takeId: clampInteger(data.takeId,1,Number.MAX_SAFE_INTEGER,null), from: typeof data.from==='string'?cleanText(data.from,MAX_LOCATION_LENGTH):null, to: typeof data.to==='string'?cleanText(data.to,MAX_LOCATION_LENGTH):null, date: typeof data.date==='string'?data.date:null, time: typeof data.time==='string'?data.time:null, seats: clampInteger(data.seats,1,MAX_SEATS,null) };
}

async function parseWithAI(message, region, contextDraft={}){
    const apiKey=process.env.GROQ_API_KEY;
    if (!apiKey){
        console.error('GROQ_API_KEY missing');
        return { role:'chat' };
    }
    const todayDate=getLocalDateString(new Date(), region.timezone);
    const local=getLocalParts(new Date(), region.timezone);
    const todayInfo=`${local.weekday} ${todayDate} ${local.hour}:${local.minute}`;
    const prompt=SYSTEM_PROMPT.replace('{COUNTRY}',region.country).replace('{TODAY_INFO}',todayInfo).replace('{TODAY_DATE}',todayDate).replace('{CONTEXT_DRAFT}',JSON.stringify(contextDraft||{}));

    for (const model of GROQ_MODELS){
        try{
            const response=await axios.post(GROQ_URL,{
                model,
                messages:[
                    { role:'system', content: prompt },
                    { role:'user', content: cleanText(message) }
                ],
                temperature:0.05,
                response_format:{ type:'json_object' },
                max_tokens:300
            },{
                headers:{
                    Authorization:`Bearer ${apiKey}`,
                    'Content-Type':'application/json'
                },
                timeout:15000
            });
            const content=response.data?.choices?.[0]?.message?.content;
            if (!content){
                console.error(`Groq empty content for ${model}`);
                continue;
            }
            const data=validateAIResult(JSON.parse(content));
            if (data.from &&!isValidLocation(data.from)) data.from=null;
            if (data.to &&!isValidLocation(data.to)) data.to=null;
            if (data.date) data.date=getRealDate(data.date, region.timezone);
            if (data.time) data.time=getRealTime(data.time, region.timezone);
            return data;
        } catch(err){
            console.error(`Groq failed [${model}]:`, err.response?.data || err.message);
            if (model===GROQ_MODELS[GROQ_MODELS.length-1]){
                logError('Groq parsing failed - all models', err.response?.data || err);
            }
        }
    }
    return { role:'chat' };
}

function parseDirectCommand(text){
    const value=String(text||'').trim().toLowerCase();
    if (value==='online') return { command:'ONLINE', filter:null };
    if (value.startsWith('online ')) return { command:'ONLINE', filter: value.slice(7).trim()||null };
    if (value==='offline') return { command:'OFFLINE' };
    if (value==='next' || value==='more' || value==='next page') return { command:'NEXT' };
    if (value==='clear' || value==='clear filters' || value==='clear filter') return { command:'CLEAR_FILTERS' };
    if (value==='show requests' || value==='show rides' || value==='rides') return { command:'SHOW_REQUESTS' };
    if (['end ride','end trip','complete','complete trip','done','finish','end','end this ride'].includes(value)) return { command:'END_RIDE' };
    const filter=value.match(/^filter\s+(.+)$/i); if (filter) return { command:'FILTER', filter: filter[1].trim() };
    const take=value.match(/^take\s+(\d+)$/i); if (take) return { command:'TAKE', takeId: Number(take[1]) };
    return null;
}

async function getOpenRides(){ return RideRequest.findAll({ where:{ status:'OPEN' }, order:[['createdAt','DESC']] }); }
async function claimRideAtomically(rideId, driverPhone){
    const [count]=await RideRequest.update({ status:'TAKEN', driverPhone },{ where:{ id: rideId, status:'OPEN', phone:{ [Op.ne]: driverPhone } } });
    if (count!==1) return null; return RideRequest.findByPk(rideId);
}

async function handleDirectCommand(cmd, phoneJid, userPhoneKey, normKey, region){
    if (!cmd?.command) return;
    if (cmd.command==='NEXT'){
        const session=getSession(userPhoneKey); if (!session.ridesList?.length){ await sendWhatsAppMessage(phoneJid,'No list active. Say ONLINE to see rides.'); return; }
        const totalPages=Math.max(1, Math.ceil(session.ridesList.length/PAGE_SIZE)); let nextPage=(session.ridesPage||0)+1; if (nextPage>=totalPages) nextPage=0;
        await sendRidesList(phoneJid, session.ridesList, session.lastTitle, nextPage, region.timezone); return;
    }
    if (cmd.command==='OFFLINE'){ const user=await User.getOrCreate(userPhoneKey); await user.setOffline(); const session=getSession(userPhoneKey); session.draft={}; ratingSessions.delete(userPhoneKey); await sendWhatsAppMessage(phoneJid,`OFFLINE - ${getTimeGreeting(region.timezone)}!`); return; }
    if (cmd.command==='ONLINE'){
        const user=await User.getOrCreate(userPhoneKey); let filter=null; let location=user.location||region.defaultCity;
        if (cmd.filter && isValidLocation(cmd.filter)){ filter=cmd.filter.replace(/^in\s+/i,'').trim(); location=filter; }
        await user.setOnline(location, DRIVER_ONLINE_HOURS); user.filterFrom=filter; await user.save();
        const rides=await getOpenRides();
        const filtered=filter?rides.filter(ride=>!isPollutedRide(ride) && (areLocationsNearby(filter, ride.from) || areLocationsNearby(filter, ride.to))):rides.filter(ride=>!isPollutedRide(ride));
        await sendWhatsAppMessage(phoneJid, filter?`ONLINE: ${filter} | Rating: ${(user.rating||5).toFixed(1)} ★ (${user.ratingCount||0})`:`ONLINE: All areas | Rating: ${(user.rating||5).toFixed(1)} ★ (${user.ratingCount||0})`);
        if (filtered.length) await sendRidesList(phoneJid, filtered, filter?`${filtered.length} RIDES NEAR ${filter.toUpperCase()}:`:`${filtered.length} OPEN RIDES:`,0,region.timezone);
        else await sendWhatsAppMessage(phoneJid, filter?`No matching rides near ${filter}. Reply CLEAR to view all.`:"No rides right now. You're online.");
        return;
    }
    if (cmd.command==='CLEAR_FILTERS'){ const user=await User.getOrCreate(userPhoneKey); user.filterFrom=null; await user.save(); const rides=await getOpenRides(); await sendRidesList(phoneJid, rides, `Filters cleared - ${rides.length} RIDES:`,0,region.timezone); return; }
    if (cmd.command==='FILTER'){
        const filter=cleanText(cmd.filter, MAX_LOCATION_LENGTH); if (!isValidLocation(filter)){ await sendWhatsAppMessage(phoneJid,'Please provide a valid location. Example: FILTER Nairobi'); return; }
        const user=await User.getOrCreate(userPhoneKey); user.filterFrom=filter; await user.save(); const rides=await getOpenRides();
        const filtered=rides.filter(ride=>!isPollutedRide(ride) && (areLocationsNearby(filter, ride.from) || areLocationsNearby(filter, ride.to)));
        await sendRidesList(phoneJid, filtered, `${filtered.length} RIDES NEAR ${filter.toUpperCase()}:`,0,region.timezone); return;
    }
    if (cmd.command==='SHOW_REQUESTS'){ const rides=await getOpenRides(); await sendRidesList(phoneJid, rides, `${rides.length} OPEN RIDES:`,0,region.timezone); return; }
    if (cmd.command==='TAKE'){ await takeRide(phoneJid, userPhoneKey, Number(cmd.takeId), region); return; }
    if (cmd.command==='END_RIDE'){ await endRideForUser(phoneJid, userPhoneKey, normKey, region); }
}

async function takeRide(phoneJid, driverPhone, rideId, region){
    const id=Number(rideId); if (!Number.isInteger(id) || id<=0){ await sendWhatsAppMessage(phoneJid,'Please reply with a valid ride ID.'); return; }
    const existing=await RideRequest.findByPk(id); if (!existing){ await sendWhatsAppMessage(phoneJid,`Ride ${id} not found. Try ONLINE.`); return; }
    if (normalizePhone(existing.phone)===normalizePhone(driverPhone)){ await sendWhatsAppMessage(phoneJid,`You can't take your own ride ${id}.`); return; }
    if (existing.status!=='OPEN'){ await sendWhatsAppMessage(phoneJid,`Ride ${id} is already taken or unavailable.`); return; }
    const ride=await claimRideAtomically(id, driverPhone); if (!ride){ await sendWhatsAppMessage(phoneJid,`Ride ${id} was just taken by another driver.`); return; }
    const riderPhone=normalizePhone(ride.phone);
    if (!riderPhone){ await RideRequest.update({ status:'OPEN', driverPhone:null },{ where:{ id: ride.id } }); await sendWhatsAppMessage(phoneJid,'This ride has invalid rider information and could not be matched.'); return; }
    setActiveChat(riderPhone, driverPhone, ride.id);
    const rider=await User.getOrCreate(riderPhone); const driver=await User.getOrCreate(driverPhone);
    const riderRating=Number(rider.rating||5); const driverRating=Number(driver.rating||5);
    await sendWhatsAppMessage(phoneJid,`MATCHED ${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\nRider: ${getDirectChatLink(riderPhone)} | Rating: ${riderRating.toFixed(1)} ★ (${rider.ratingCount||0})\nYou can now chat. Say END RIDE when the trip is complete.`);
    await sendWhatsAppMessage(riderPhone,`DRIVER FOUND ${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${getDirectChatLink(driverPhone)} | Rating: ${driverRating.toFixed(1)} ★ (${driver.ratingCount||0})\nYou can now chat with your driver.`);
}

async function checkAndForwardChat(phoneJid, text, realPhone){
    const key=normalizePhone(realPhone||phoneJid); const chat=activeChats.get(key); if (!chat) return false;
    try{
        const ride=await RideRequest.findByPk(chat.rideId); if (!ride || ride.status!=='TAKEN'){ killChatFor(key); return false; }
        const other=normalizePhone(chat.with); if (!other){ killChatFor(key); return false; }
        const sender=normalizePhone(ride.phone)===key?'Rider':'Driver'; const receiver=sender==='Rider'?'driver':'rider';
        await sendWhatsAppMessage(other,`${sender} ${ride.id}: ${cleanText(text)}`); await sendWhatsAppMessage(phoneJid,`Sent to ${receiver}.`); return true;
    } catch(err){ logError('Chat forwarding failed',err); return false; }
}

async function endRideForUser(phoneJid, userPhoneKey, normKey, region){
    const key=normalizePhone(normKey||userPhoneKey); if (!key || endingLocks.has(key)) return; endingLocks.add(key);
    try{
        let ride=null; const chat=getActiveChat(key); if (chat?.rideId) ride=await RideRequest.findByPk(chat.rideId);
        if (!ride || ride.status!=='TAKEN' || (normalizePhone(ride.phone)!==key && normalizePhone(ride.driverPhone)!==key)){
            ride=await RideRequest.findOne({ where:{ status:'TAKEN', [Op.or]:[{ phone:key },{ driverPhone:key }] }, order:[['updatedAt','DESC']] });
        }
        if (!ride){ await sendWhatsAppMessage(phoneJid,'No active trip found. Chat already closed.\nNeed another? Say: Need a ride'); return; }
        const [updated]=await RideRequest.update({ status:'COMPLETED' },{ where:{ id: ride.id, status:'TAKEN' } });
        if (!updated){ await sendWhatsAppMessage(phoneJid,'This trip was already completed.'); return; }
        const riderPhone=normalizePhone(ride.phone); const driverPhone=normalizePhone(ride.driverPhone); const otherPhone=riderPhone===key?driverPhone:riderPhone;
        killChatFor(key); clearSession(key);
        if (!otherPhone){ await sendWhatsAppMessage(phoneJid,`Trip ${ride.id} ended. Chat closed.\nNeed another? Say: Need a ride`); return; }
        ratingSessions.delete(key); ratingSessions.delete(otherPhone);
        ratingSessions.set(key,{ rideId: ride.id, other: otherPhone }); ratingSessions.set(otherPhone,{ rideId: ride.id, other: key });
        const message=`Trip ${ride.id} ended. Thanks for using Induu!\n\nPlease rate your ${key===riderPhone?'driver':'rider'}: Reply 1-5 stars (5 = Excellent)`;
        await sendWhatsAppMessage(phoneJid, message);
        if (otherPhone!==key) await sendWhatsAppMessage(otherPhone,`Trip ${ride.id} ended. Thanks for using Induu!\n\nPlease rate your ${otherPhone===riderPhone?'driver':'rider'}: Reply 1-5 stars (5 = Excellent)`);
    } catch(err){ logError('End ride failed',err); await sendWhatsAppMessage(phoneJid,'I could not end the trip right now. Please try END RIDE again.'); } finally { endingLocks.delete(key); }
}

async function handleRideLogic(phoneJid, text, realPhone) {
    const rawText = cleanText(text);
    if (!rawText) return;
    const lowerText = rawText.toLowerCase().trim();
    const normKey = canonicalPhone(realPhone, phoneJid);
    if (!normKey) return;

    const region = detectUserRegion(normKey);
    const session = getSession(normKey);

    try {
        const ratingSession = ratingSessions.get(normKey);
        if (ratingSession) {
            const looksLikeNewRide = lowerText.includes('need a ride') || lowerText.includes('need ride') || (lowerText.includes('from ') && lowerText.includes(' to ')) || lowerText.includes('miles');
            if (!looksLikeNewRide && rawText.length <= 30) {
                const rating = parseRating(lowerText);
                if (rating) {
                    const newAverage = await addRatingToUser(ratingSession.other, rating);
                    ratingSessions.delete(normKey);
                    ratingSessions.delete(normalizePhone(ratingSession.other));
                    await sendWhatsAppMessage(phoneJid, `Rating saved! You rated ${rating} ★ for trip ${ratingSession.rideId}. Their new average is ${newAverage.toFixed(1)} ★.\n\nNeed another? Say: Need a ride`);
                    return;
                }
                if (lowerText === 'skip' || lowerText === 'no') {
                    ratingSessions.delete(normKey);
                    await sendWhatsAppMessage(phoneJid, 'Skipped rating. Need another? Say: Need a ride');
                    return;
                }
                if (['thanks', 'thank you', 'thankyou', 'thx'].includes(lowerText)) {
                    await sendWhatsAppMessage(phoneJid, 'You are welcome! Please rate your last trip 1-5 or say skip.');
                    return;
                }
            } else {
                ratingSessions.delete(normKey);
            }
        }

        if (activeChats.has(normKey)) {
            const control = parseDirectCommand(rawText);
            const controlWords = ['end ride', 'end trip', 'complete', 'done', 'finish', 'need a ride', 'online', 'offline'];
            const isControl =!!control || controlWords.some(word => lowerText === word || lowerText.startsWith(`${word} `));
            if (!isControl) {
                if (await checkAndForwardChat(phoneJid, rawText, normKey)) return;
            }
        }

        if (/^\d+$/.test(lowerText)) { await takeRide(phoneJid, normKey, Number(lowerText), region); return; }
        if (/^take\s+\d+$/i.test(lowerText)) { await takeRide(phoneJid, normKey, Number(lowerText.replace(/\D/g, '')), region); return; }

        const direct = parseDirectCommand(rawText);
        if (direct) {
            if (direct.command === 'TAKE') await takeRide(phoneJid, normKey, direct.takeId, region);
            else await handleDirectCommand(direct, phoneJid, normKey, normKey, region);
            return;
        }
        if (lowerText === 'next' || lowerText === 'more' || lowerText === 'next page') {
            await handleDirectCommand({ command: 'NEXT' }, phoneJid, normKey, normKey, region);
            return;
        }

        const draft = session.draft || {};

        if (draft.role === 'rider') {
            if (!draft.from && isValidLocation(rawText) &&!getRealTime(rawText, region.timezone)) {
                draft.from = rawText;
                session.draft = draft;
                await sendWhatsAppMessage(phoneJid, `Got it, from ${rawText} -- where to? Example: ${region.exampleDest}`);
                return;
            }
            if (draft.from &&!draft.to && isValidLocation(rawText) &&!getRealTime(rawText, region.timezone)) {
                if (locationsEqual(draft.from, rawText)) {
                    await sendWhatsAppMessage(phoneJid, `From and to cannot be the same (${draft.from}). Where to?`);
                    return;
                }
                draft.to = rawText;
                session.draft = draft;
                await sendWhatsAppMessage(phoneJid, `Got it, ${draft.from} -> ${rawText}. What time? Example: 5pm or now`);
                return;
            }
            if (draft.from && draft.to &&!draft.time) {
                const parsedTime = getRealTime(rawText, region.timezone);
                if (parsedTime) {
                    const time = parsedTime;
                    const date = getRealDate('today', region.timezone);
                    const seats = clampInteger(draft.seats, 1, MAX_SEATS, 1);
                    const rideRequest = await RideRequest.createCustom(normKey, { from: draft.from, to: draft.to, time, date, seats });
                    const displayDate = toDisplayDate(date, region.timezone);
                    await sendWhatsAppMessage(phoneJid, `RIDE ${rideRequest.id} CREATED\n${rideRequest.from} -> ${rideRequest.to} ${toDisplayTime(rideRequest.time)} ${displayDate} • ${seats} ${seats === 1? 'person' : 'people'}\nAlerting drivers...`);
                    const drivers = await User.findAll({ where: { isOnline: true, onlineUntil: { [Op.gt]: new Date() } } });
                    const notified = new Set();
                    for (const driver of drivers) {
                        const driverPhone = normalizePhone(driver.phone);
                        if (!driverPhone || driverPhone === normKey || notified.has(driverPhone)) continue;
                        const locationMatch =!driver.location || areLocationsNearby(driver.location, rideRequest.from) || areLocationsNearby(driver.location, rideRequest.to);
                        if (!locationMatch) continue;
                        notified.add(driverPhone);
                        await sendWhatsAppMessage(driverPhone, `NEW RIDE MATCH: ${rideRequest.id}\n${rideRequest.from} -> ${rideRequest.to} | ${toDisplayTime(rideRequest.time)} ${displayDate} • ${seats} ${seats === 1? 'person' : 'people'}\nReply ${rideRequest.id} to take`);
                    }
                    clearSession(normKey);
                    return;
                }
            }
        }

        const ai = await parseWithAI(rawText, region, session.draft || {});

        if (ai.role === 'chat') {
            const reply = await answerGeneralQuestion(rawText, region, session.draft?.from);
            await sendWhatsAppMessage(phoneJid, reply || "Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip.");
            return;
        }

        if (ai.role === 'driver') {
            let from = ai.from || draft.from || null;
            let to = ai.to || draft.to || null;
            if (from &&!isValidLocation(from)) from = null;
            if (to &&!isValidLocation(to)) to = null;
            if (!from && isValidLocation(rawText) &&!isCommandPhrase(rawText)) from = rawText;
            if (!from) {
                session.draft = { role: 'driver' };
                await sendWhatsAppMessage(phoneJid, `Where are you driving from? Example: ${region.examplePlaces}`);
                return;
            }
            if (!to) {
                session.draft = { role: 'driver', from };
                await sendWhatsAppMessage(phoneJid, `Got it, driving from ${from} -- where to? Example: ${region.exampleDest}`);
                return;
            }
            if (locationsEqual(from, to)) {
                session.draft = { role: 'driver', from, to: null };
                await sendWhatsAppMessage(phoneJid, `From and to cannot be the same (${from}). Where are you driving to?`);
                return;
            }
            const user = await User.getOrCreate(normKey);
            await user.setOnline(from, DRIVER_ONLINE_HOURS);
            user.filterFrom = from;
            await user.save();
            const rides = await getOpenRides();
            const matching = rides.filter(ride =>!isPollutedRide(ride) && routeMatches(from, to, ride.from, ride.to));
            await sendWhatsAppMessage(phoneJid, matching.length? `You're online: ${from} → ${to} • ${matching.length} matching ride${matching.length === 1? '' : 's'}` : `You're online: ${from} → ${to} • No matching rides right now.`);
            await sendRidesList(phoneJid, matching, `${matching.length} RIDES MATCHING ${from.toUpperCase()} -> ${to.toUpperCase()}:`, 0, region.timezone);
            clearSession(normKey);
            return;
        }

        if (ai.role === 'rider') {
            let from = ai.from || draft.from || null;
            let to = ai.to || draft.to || null;
            let time = ai.time || draft.time || null;
            let date = ai.date || draft.date || null;
            let seats = ai.seats || draft.seats || null;
            if (from &&!isValidLocation(from)) from = null;
            if (to &&!isValidLocation(to)) to = null;
            if (['need a ride', 'i need a ride', 'need ride', 'i need ride'].includes(lowerText)) {
                session.draft = { role: 'rider', seats };
                await sendWhatsAppMessage(phoneJid, `Where are you riding from? Example: ${region.examplePlaces}`);
                return;
            }
            if (!from) {
                session.draft = { role: 'rider', seats };
                await sendWhatsAppMessage(phoneJid, `Where are you riding from? Example: ${region.examplePlaces}`);
                return;
            }
            if (!to) {
                session.draft = { role: 'rider', from, seats };
                await sendWhatsAppMessage(phoneJid, `Got it, from ${from} -- where to? Example: ${region.exampleDest}`);
                return;
            }
            if (!time) {
                session.draft = { role: 'rider', from, to, date, seats };
                await sendWhatsAppMessage(phoneJid, 'What time? Example: 5pm or now');
                return;
            }
            if (!date) date = getRealDate('today', region.timezone);
            seats = clampInteger(seats, 1, MAX_SEATS, 1);
            const rideRequest = await RideRequest.createCustom(normKey, { from, to, time, date, seats });
            const displayDate = toDisplayDate(date, region.timezone);
            await sendWhatsAppMessage(phoneJid, `RIDE ${rideRequest.id} CREATED\n${rideRequest.from} -> ${rideRequest.to} ${toDisplayTime(rideRequest.time)} ${displayDate} • ${seats} ${seats === 1? 'person' : 'people'}\nAlerting drivers...`);
            const drivers = await User.findAll({ where: { isOnline: true, onlineUntil: { [Op.gt]: new Date() } } });
            const notified = new Set();
            for (const driver of drivers) {
                const driverPhone = normalizePhone(driver.phone);
                if (!driverPhone || driverPhone === normKey || notified.has(driverPhone)) continue;
                const locationMatch =!driver.location || areLocationsNearby(driver.location, rideRequest.from) || areLocationsNearby(driver.location, rideRequest.to);
                if (!locationMatch) continue;
                notified.add(driverPhone);
                await sendWhatsAppMessage(driverPhone, `NEW RIDE MATCH: ${rideRequest.id}\n${rideRequest.from} -> ${rideRequest.to} | ${toDisplayTime(rideRequest.time)} ${displayDate} • ${seats} ${seats === 1? 'person' : 'people'}\nReply ${rideRequest.id} to take`);
            }
            clearSession(normKey);
            return;
        }

        if (ai.role === 'command' || ai.command) {
            await handleDirectCommand({ command: ai.command, filter: ai.filter, takeId: ai.takeId }, phoneJid, normKey, normKey, region);
            return;
        }

        const reply = await answerGeneralQuestion(rawText, region, session.draft?.from);
        await sendWhatsAppMessage(phoneJid, reply || "Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip.");
    } catch (err) {
        logError(`Error in handleRideLogic [${normKey}]`, err);
        await sendWhatsAppMessage(phoneJid, 'Sorry, something went wrong while processing that. Please try again.');
    }
}

function extractMessageText(message){
    if (!message) return ''; if (message.conversation) return message.conversation; if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption; if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.buttonsResponseMessage) return (message.buttonsResponseMessage.selectedButtonId||message.buttonsResponseMessage.selectedDisplayText||'');
    if (message.templateButtonReplyMessage) return (message.templateButtonReplyMessage.selectedId||message.templateButtonReplyMessage.selectedDisplayText||'');
    if (message.listResponseMessage) return (message.listResponseMessage.singleSelectReply?.selectedRowId||message.listResponseMessage.title||''); return '';
}

function registerMessageHandler(socket){
    if (!socket) return;
    socket.ev.on('messages.upsert', async ({ messages })=>{
        for (const msg of messages||[]){
            try{
                if (!msg?.message) continue; if (msg.key?.fromMe) continue; const remoteJid=msg.key?.remoteJid||''; if (!remoteJid) continue; if (remoteJid==='status@broadcast') continue; if (remoteJid.includes('@g.us')) continue;
                const text=extractMessageText(msg.message); if (!text) continue; let realPhone=remoteJid;
                if (remoteJid.includes('@lid')){ if (msg.key?.participant &&!msg.key.participant.includes('@lid')) realPhone=msg.key.participant; else if (msg.key?.remoteJidAlt &&!msg.key.remoteJidAlt.includes('@lid')) realPhone=msg.key.remoteJidAlt; }
                const phone=canonicalPhone(realPhone, remoteJid); if (!phone) continue;
                console.log(`MSG ${phone}: ${cleanText(text,500)}`); await queueUserMessage(phone, ()=>handleRideLogic(remoteJid, text, phone));
            } catch(err){ if (String(err?.message||'').includes('Bad MAC')) continue; logError('Message handling error',err); }
        }
    });
}

async function startWhatsApp(){
    if (startingWhatsApp || shuttingDown) return; startingWhatsApp=true;
    try{
        fs.mkdirSync(AUTH_PATH,{ recursive:true }); const { state, saveCreds }=await useMultiFileAuthState(AUTH_PATH); const { version }=await fetchLatestBaileysVersion();
        const newSocket=makeWASocket({ version, auth: state, logger: pino({ level:'silent' }), browser:['Induu Universal','Chrome','1.0'], shouldSyncHistoryMessage:()=>false, syncFullHistory:false, markOnlineOnConnect:false, getMessage: async()=>undefined });
        sock=newSocket; newSocket.ev.on('creds.update', saveCreds);
        newSocket.ev.on('connection.update', async update=>{
            const { connection, lastDisconnect, qr }=update; if (qr){ qrLast=qr; console.log('WhatsApp QR available.'); }
            if (connection==='open'){ console.log('WhatsApp Connected'); qrLast=null; startingWhatsApp=false; if (reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer=null; } return; }
            if (connection==='close'){
                const code=lastDisconnect?.error?.output?.statusCode; if (sock===newSocket) sock=null; qrLast=null; startingWhatsApp=false;
                const loggedOut=code===DisconnectReason.loggedOut || code===401;
                if (loggedOut){ try{ if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH,{ recursive:true, force:true }); } catch(err){ logError('Auth cleanup failed',err); } }
                if (!reconnectTimer &&!shuttingDown){ reconnectTimer=setTimeout(()=>{ reconnectTimer=null; startWhatsApp().catch(err=>logError('Reconnect failed',err)); }, RECONNECT_DELAY_MS); }
            }
        });
        registerMessageHandler(newSocket);
    } catch(err){
        startingWhatsApp=false; sock=null; logError('WhatsApp startup error',err);
        if (!reconnectTimer &&!shuttingDown){ reconnectTimer=setTimeout(()=>{ reconnectTimer=null; startWhatsApp().catch(error=>logError('Retry startup failed',error)); }, RECONNECT_DELAY_MS); }
    }
}

async function initializeDatabase(){ try{ await sequelize.authenticate(); await sequelize.sync({ alter:true }); dbReady=true; console.log('DB Connected and Synced'); } catch(err){ dbReady=false; logError('Database initialization failed',err); } }
async function cleanupExpiredData(){
    try{
        if (typeof RideRequest.clearExpired==='function') await RideRequest.clearExpired();
        await User.update({ isOnline:false, onlineUntil:null },{ where:{ isOnline:true, onlineUntil:{ [Op.lte]: new Date() } } });
    } catch(err){ logError('Maintenance cleanup failed',err); }
}

function adminOnly(req,res,next){
    const secret=process.env.ADMIN_SECRET; if (!secret) return res.status(503).send('Admin API disabled: ADMIN_SECRET is not configured');
    const auth=req.get('authorization')||''; if (auth!==`Bearer ${secret}`) return res.status(401).send('Unauthorized'); next();
}

app.get('/ping',(req,res)=>{ res.json({ ok:true, service:'Induu', database: dbReady, whatsapp:!!sock }); });
app.get('/',(req,res)=>{ res.send('Induu LIVE - Dynamic Rides'); });
app.get('/qr', adminOnly, (req,res)=>{ if (!qrLast) return res.send('<h1>Connected or QR not currently available.</h1>'); res.type('text/plain').send(qrLast); });
app.post('/clearall', adminOnly, async (req,res)=>{
    try{ await RideRequest.destroy({ where:{} }); await RideOffer.destroy({ where:{} }); activeChats.clear(); userSessions.clear(); ratingSessions.clear(); endingLocks.clear(); res.json({ ok:true, message:'All rides deleted and runtime memory cleared.' }); }
    catch(err){ logError('clearall failed',err); res.status(500).json({ ok:false, error:'Failed to clear data.' }); }
});
app.post('/cleardb', adminOnly, async (req,res)=>{
    try{
        const confirmation=req.get('x-confirm-db-wipe'); if (confirmation!=='WIPE_DATABASE') return res.status(400).send('Database wipe blocked. Set X-Confirm-DB-Wipe: WIPE_DATABASE.');
        await sequelize.sync({ force:true }); activeChats.clear(); userSessions.clear(); ratingSessions.clear(); res.json({ ok:true, message:'Full database wiped.' });
    } catch(err){ logError('cleardb failed',err); res.status(500).json({ ok:false, error:'Failed to wipe database.' }); }
});
app.get('/ratings', adminOnly, async (req,res)=>{
    try{ const users=await User.findAll({ order:[['rating','DESC']] }); res.json(users.map(user=>({ phone: normalizePhone(user.phone), rating: Number(user.rating||5), count: Math.max(0, Number(user.ratingCount||0)) }))); }
    catch(err){ logError('ratings endpoint failed',err); res.status(500).json({ error:'Failed to load ratings.' }); }
});

const server=app.listen(PORT, ()=>{ console.log(`Induu Running on ${PORT}`); });
(async()=>{ await initializeDatabase(); await cleanupExpiredData(); await startWhatsApp(); })();
const maintenanceTimer=setInterval(cleanupExpiredData, EXPIRY_INTERVAL_MS);

async function shutdown(signal){
    if (shuttingDown) return; shuttingDown=true; console.log(`${signal} received. Shutting down...`); clearInterval(maintenanceTimer);
    if (reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer=null; }
    try{ if (sock){ sock.end(undefined); sock=null; } } catch(_){}
    try{ await sequelize.close(); } catch(_){}
    server.close(()=>{ process.exit(0); }); setTimeout(()=>process.exit(0),10000).unref();
}

process.on('SIGTERM',()=>shutdown('SIGTERM')); process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('unhandledRejection', reason=>{ logError('Unhandled promise rejection',reason); });
process.on('uncaughtException', err=>{ logError('Uncaught exception',err); });
