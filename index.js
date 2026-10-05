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
app.use(express.urlencoded({ extended: true }));

const PORT = Number(process.env.PORT || 10000);
const AUTH_PATH = path.join(__dirname, 'auth_info');
const PAGE_SIZE = 15;
const DEFAULT_ONLINE_HOURS = 2;
const DEFAULT_TIMEZONE = 'America/Chicago';
const GROQ_MODEL = process.env.GROQ_PARSER_MODEL || 'openai/gpt-oss-20b';
const GROQ_CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-20b';

let sock = null;
let qrLast = null;
let reconnectTimer = null;
let startingWhatsApp = false;

const userSessions = new Map();
const activeChats = new Map();
const ratingSessions = new Map();
const endingLocks = new Set();
const userQueues = new Map();

function normalizePhone(value) { if (!value) return ''; return String(value).split('@')[0].replace(/[^0-9]/g, ''); }
function canonicalPhone(realPhone, remoteJid) { return normalizePhone(realPhone) || normalizePhone(remoteJid); }
function jidFor(value) { if (!value) return ''; if (String(value).includes('@')) return String(value); return `${normalizePhone(value)}@s.whatsapp.net`; }
function getSessionKey(value) { return normalizePhone(value) || String(value || ''); }
function getSession(phone) {
  const key = getSessionKey(phone);
  if (!userSessions.has(key)) userSessions.set(key, { draft: {}, ridesList: [], ridesPage: 0, lastTitle: 'RIDES:', updatedAt: Date.now() });
  const s = userSessions.get(key); s.updatedAt = Date.now(); return s;
}
function clearSession(phone) { userSessions.delete(getSessionKey(phone)); }
function mergeDraft(existing, updates) { return {...(existing||{}),...(updates||{}), role: (updates&&updates.role) || (existing&&existing.role) }; }
function queueUserMessage(phone, task) {
  const key = getSessionKey(phone) || 'unknown';
  const previous = userQueues.get(key) || Promise.resolve();
  const next = previous.catch(()=>{}).then(task).catch(err=>console.error('User queue error:', err?.stack||err?.message||err));
  userQueues.set(key, next);
  next.finally(()=>{ if (userQueues.get(key)===next) userQueues.delete(key); }).catch(()=>{});
  return next;
}
function detectUserRegion(jid) {
  const raw = normalizePhone(jid);
  if (raw.startsWith('254') || (raw.length===10 && raw.startsWith('0'))) return { country:'KE', timezone:'Africa/Nairobi', defaultCity:'Juja', defaultDestination:'Nairobi', examplePlaces:'Juja or Ruiru', exampleDest:'Thika or Nairobi' };
  if (raw.startsWith('1') || raw.length===10) return { country:'US', timezone:'America/Chicago', defaultCity:'Denton', defaultDestination:'Dallas', examplePlaces:'Denton or Frisco', exampleDest:'Dallas or Fort Worth' };
  return { country:'US', timezone:DEFAULT_TIMEZONE, defaultCity:'Main Campus', defaultDestination:'Downtown', examplePlaces:'Campus or North Side', exampleDest:'Downtown or Station' };
}
function getUserNow(timezone=DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const v = Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return new Date(Date.UTC(Number(v.year),Number(v.month)-1,Number(v.day),Number(v.hour),Number(v.minute),Number(v.second)));
}
function getLocalDateString(date=new Date(), timezone=DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const v = Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
function isValidDateString(s){ return /^\d{4}-\d{2}-\d{2}$/.test(String(s||'')); }
function addLocalDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate()+days); return d; }
function getLocalParts(date=new Date(), timezone=DEFAULT_TIMEZONE){
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'long',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
  return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function getTimeGreeting(timezone){ const h=Number(getLocalParts(new Date(),timezone).hour); if(h>=5&&h<12) return 'Good morning'; if(h>=12&&h<15) return 'Good afternoon'; if(h>=15&&h<19) return 'Good evening'; return 'Hello'; }
function getRealDate(aiDate, timezone=DEFAULT_TIMEZONE){
  const today = getLocalDateString(new Date(), timezone);
  if(!aiDate) return today;
  let s = String(aiDate).toLowerCase().trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if(s.includes('day after tomorrow')) return getLocalDateString(addLocalDays(getUserNow(timezone),2),timezone);
  if(s.includes('tomorrow')) return getLocalDateString(addLocalDays(getUserNow(timezone),1),timezone);
  if(s.includes('today')||s.includes('now')||s.includes('asap')) return today;
  const weekdays=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for(let i=0;i<weekdays.length;i++){
    if(!s.includes(weekdays[i])) continue;
    const cur = new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'long'}).format(new Date()).toLowerCase();
    const curIdx = weekdays.indexOf(cur); let diff = i - curIdx; if(diff<=0) diff+=7;
    return getLocalDateString(addLocalDays(getUserNow(timezone),diff),timezone);
  }
  const inDays = s.match(/in\s+(\d+)\s+days?/); if(inDays) return getLocalDateString(addLocalDays(getUserNow(timezone),Number(inDays[1])),timezone);
  return today;
}
function getRealTime(aiTime, timezone=DEFAULT_TIMEZONE){
  if(!aiTime) return null;
  let v = String(aiTime).toLowerCase().trim().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, m=>({one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10',eleven:'11',twelve:'12'}[m]||m));
  if(['now','asap','flexible','just now','immediately','now now'].includes(v)){ const p=getLocalParts(new Date(),timezone); return `${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`; }
  if(/\b(this )?morning\b/.test(v)) return '09:00';
  if(/\b(this )?afternoon\b/.test(v)) return '14:00';
  if(/\b(evening|tonight)\b/.test(v)) return '19:00';
  const amPm = v.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if(amPm){ let h=Number(amPm[1]); const m=Number(amPm[2]||0); const p=amPm[3]; if(p==='pm'&&h<12) h+=12; if(p==='am'&&h===12) h=0; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
  const tf = v.match(/\b(\d{1,2}):(\d{2})\b/); if(tf) return `${String(Number(tf[1])).padStart(2,'0')}:${String(Number(tf[2])).padStart(2,'0')}`;
  return null;
}
function extractDeterministicFields(text, timezone=DEFAULT_TIMEZONE){
  const l = String(text||'').toLowerCase();
  let date=null, time=null, seats=null, bags=null;
  if(l.includes('day after tomorrow')) date=getLocalDateString(addLocalDays(getUserNow(timezone),2),timezone);
  else if(l.includes('tomorrow')) date=getLocalDateString(addLocalDays(getUserNow(timezone),1),timezone);
  else if(l.includes('today')) date=getLocalDateString(new Date(),timezone);
  else {
    const wd = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    for(const w of wd){ if(l.includes(w)){ date=getRealDate(w,timezone); break; } }
    const inD = l.match(/in\s+(\d+)\s+days?/); if(inD) date=getLocalDateString(addLocalDays(getUserNow(timezone),Number(inD[1])),timezone);
  }
  time=getRealTime(l,timezone);
  const seatsM = l.match(/(?:for\s+)?(\d+)\s*(?:people|persons|passengers|seats|pax)/) || l.match(/me\s*plus\s*(\d+)/) || l.match(/(\d+)\s*people/);
  if(seatsM) seats=Math.max(1,Math.min(6,Number(seatsM[1])||1));
  if(l.includes('for 2')||l.includes('2 people')) seats=seats||2;
  const bagsM = l.match(/(\d+)\s*bags?/); if(bagsM) bags=Number(bagsM[1]);
  return { date, time, seats, bags };
}
function normalizeLocation(v){ return String(v||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim(); }
function locationWords(v){ return normalizeLocation(v).split(/\s+/).filter(Boolean); }
function areLocationsNearby(a,b){
  const x=normalizeLocation(a), y=normalizeLocation(b); if(!x||!y) return false;
  if(x===y||x.includes(y)||y.includes(x)) return true;
  const aW=locationWords(x), bSet=new Set(locationWords(y));
  return aW.some(w=>w.length>=4&&bSet.has(w));
}
function isValidLocation(value){
  if(!value) return false; const l=normalizeLocation(value); if(l.length<3||l.length>60) return false;
  const badExact=new Set(['hi','hello','hey','hii','heyy','yo','online','offline','thanks','thank you','need a ride','need ride','i need a ride']);
  if(badExact.has(l)) return false;
  return!/\bneed\s+(?:a\s+)?ride\b/i.test(l) &&!/\bwhere\s+is\b/i.test(l) &&!/\bwhat\s+is\b/i.test(l);
}
function isCommandPhrase(value){ if(!value) return true; const l=normalizeLocation(value); const exact=new Set(['i want to give ride','give ride','ride available','offer ride','i am driver','online','offline','clear','next','hi','hello','hey','thanks','ok','okay']); return exact.has(l); }
function isPollutedRide(ride){ const fields=[ride?.from||'',ride?.to||'',ride?.date||''].map(v=>String(v).toLowerCase()); const suspicious=[/\bwhere\b/,/\bwho\b/,/\bwhat\b/,/\bwhen\b/,/\bpresident\b/,/\bfounder\b/,/\bfilter\b/]; if(fields.some(f=>suspicious.some(re=>re.test(f)))) return true; return!isValidLocation(ride?.from)||!isValidLocation(ride?.to); }
function toDisplayTime(time){ if(!time||time==='Flexible') return 'now'; const [hRaw,mRaw]=String(time).split(':'); const h=Number(hRaw), m=Number(mRaw||0); if(!Number.isFinite(h)) return String(time); return `${h%12||12}:${String(m).padStart(2,'0')} ${h>=12?'PM':'AM'}`; }
function toDisplayDate(date, timezone){ if(!date) return ''; if(!isValidDateString(date)) return String(date); const today=getLocalDateString(new Date(),timezone); const tomorrow=getLocalDateString(addLocalDays(getUserNow(timezone),1),timezone); if(date===today) return 'Today'; if(date===tomorrow) return 'Tomorrow'; const [y,m,d]=date.split('-').map(Number); return new Date(Date.UTC(y,m-1,d,12)).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}); }
function sortAndTagRides(rides, timezone){
  const now=getUserNow(timezone);
  return rides.map(r=>{ const item=r.dataValues||r; const date=isValidDateString(item.date)?item.date:getLocalDateString(new Date(),timezone); let h=now.getUTCHours(), m=now.getUTCMinutes(); if(item.time&&item.time!=='Flexible'&&item.time!=='now'){ const [ph,pm]=String(item.time).split(':').map(Number); if(Number.isFinite(ph)) h=ph; if(Number.isFinite(pm)) m=pm; } const [y,mo,d]=date.split('-').map(Number); const target=new Date(Date.UTC(y,mo-1,d,h,m,0)); const diffMins=Math.round((target-now)/60000); return {...item,diffMins,isUrgent:diffMins>=-30&&diffMins<=60}; }).sort((a,b)=>{ if(a.isUrgent!==b.isUrgent) return a.isUrgent?-1:1; return a.diffMins-b.diffMins; });
}
function getDirectChatLink(jid){ return `https://wa.me/${normalizePhone(jid)}`; }
function parseRating(text){ const t=String(text||'').toLowerCase().trim(); if(t.length>20) return null; const direct=t.match(/^([1-5])(?:\s*stars?)?$/i); if(direct) return Number(direct[1]); return null; }
function setRatingSession(phone,data){ const key=normalizePhone(phone); if(!key) return; ratingSessions.set(key,data); }
function getRatingSession(phone, remoteJid){ for(const v of [phone,remoteJid].map(normalizePhone).filter(Boolean)){ const f=ratingSessions.get(v); if(f) return f; } return null; }
function clearRatingSession(phone,remoteJid,other){ for(const v of [phone,remoteJid,other]){ const k=normalizePhone(v); if(k) ratingSessions.delete(k); } }
async function addRatingToUser(phone, stars){
  const key=normalizePhone(phone); if(!key) return 5;
  try{ const user=await User.getOrCreate(key); if(!user.ratingCount||user.ratingCount<1){ user.rating=stars; user.ratingCount=1; } else { const total=Number(user.rating||5)*Number(user.ratingCount); user.ratingCount+=1; user.rating=(total+stars)/user.ratingCount; } await user.save(); return Number(user.rating||5); } catch(e){ console.error('Rating error:',e?.message||e); return 5; }
}
async function sendGupshupMessage(toJid, text){ if(!toJid||!sock) return false; try{ await sock.sendMessage(jidFor(toJid),{text:String(text)}); return true; } catch(err){ console.error('Send error:',err?.message||err); return false; } }
function adminOnly(req,res,next){ const secret=process.env.ADMIN_SECRET; if(!secret) return res.status(503).send('Admin API disabled'); const auth=req.get('authorization')||''; if(auth!==`Bearer ${secret}`) return res.status(401).send('Unauthorized'); next(); }

async function sendRidesList(toJid, rides, title='RIDES:', page=0, timezone=DEFAULT_TIMEZONE){
  if(!rides?.length){ await sendGupshupMessage(toJid,'No rides right now.\nSay ONLINE to see available rides.'); return; }
  const clean=rides.map(r=>r?.dataValues||r).filter(r=>!isPollutedRide(r)).filter(r=>!isCommandPhrase(r.from)&&!isCommandPhrase(r.to));
  if(!clean.length){ await sendGupshupMessage(toJid,'No valid rides available right now.'); return; }
  const sorted=sortAndTagRides(clean,timezone); const totalPages=Math.max(1,Math.ceil(sorted.length/PAGE_SIZE)); const safePage=Math.min(Math.max(0,Number(page)||0),totalPages-1); const chunk=sorted.slice(safePage*PAGE_SIZE,safePage*PAGE_SIZE+PAGE_SIZE);
  let out=`*${sorted.length} rides* - P${safePage+1}/${totalPages} - Reply ID to take\n\n`;
  for(const ride of chunk){
    let rating=5, count=0, username=`Rider ${ride.id}`;
    try{ const u=await User.getOrCreate(ride.phone); rating=Number(u.rating||5); count=Number(u.ratingCount||0); if(u.name&&String(u.name).length>=2) username=u.name; } catch(_){}
    const from=String(ride.from||'').trim(), to=String(ride.to||'').trim();
    const niceFrom=from.charAt(0).toUpperCase()+from.slice(1), niceTo=to.charAt(0).toUpperCase()+to.slice(1);
    const seats=Number(ride.seats||1);
    out+=`~ ${username} • ${rating.toFixed(1)}★ (${count})\n${niceFrom} → ${niceTo} • ${toDisplayDate(ride.date,timezone)} ${toDisplayTime(ride.time)} • ${seats} ${seats===1?'person':'people'}\nReply ${ride.id}\n\n`;
  }
  out+=totalPages>1&&safePage<totalPages-1?`NEXT for more | Reply ID e.g. ${chunk[0].id}`:`Reply with ID e.g. ${chunk[0].id}`;
  await sendGupshupMessage(toJid,out.trim());
  const session=getSession(toJid); session.ridesList=sorted; session.ridesPage=safePage; session.lastTitle=title;
}
async function checkAndForwardChat(phoneJid, text, realPhone){
  const key=normalizePhone(realPhone)||normalizePhone(phoneJid); const chat=activeChats.get(key); if(!chat) return false;
  try{ const ride=await RideRequest.findByPk(chat.rideId); if(!ride||ride.status!=='TAKEN'){ killChatFor(key); return false; } const sender=normalizePhone(ride.phone)===key?'Rider':'Driver'; const receiver=sender==='Rider'?'driver':'rider'; await sendGupshupMessage(chat.with,`${sender} ${chat.rideId}: ${text}`); await sendGupshupMessage(phoneJid,`Sent to ${receiver}`); return true; } catch(err){ console.error('Chat bridge error:',err?.message||err); return false; }
}
function setActiveChat(a,b,rideId){ const left=normalizePhone(a), right=normalizePhone(b); if(!left||!right) return; activeChats.set(left,{with:right,rideId}); activeChats.set(right,{with:left,rideId}); }
function killChatFor(phone){ const key=normalizePhone(phone); if(!key) return; const chat=activeChats.get(key); activeChats.delete(key); if(chat?.with) activeChats.delete(normalizePhone(chat.with)); }

async function answerGeneralQuestion(question, region, loc){
  const lower=String(question||'').toLowerCase().trim();
  if(!lower||lower.length<=2) return null; if(/^\d+$/.test(lower)) return null;
  if(['thanks','thank you','thankyou','thx'].includes(lower)) return "You're welcome!";
  if(['ok','okay','cool','nice','great','alright'].includes(lower)) return 'Got it!';
  if(['hi','hey','hello','hii','heyy','yo'].includes(lower)) return `${getTimeGreeting(region.timezone)}! I'm Induu — I help students with rides.`;
  if(lower.includes('who are you')||lower.includes('what are you')) return "I'm Induu! I help students connect with affordable rides near campus.";
  if(!process.env.GROQ_API_KEY) return null;
  try{
    const system=`You are Induu, a friendly student ride assistant. Location: ${loc||region.defaultCity}, ${region.country}. Answer in clear English in 2-3 short sentences. No emojis.`;
    const res=await axios.post('https://api.groq.com/openai/v1/chat/completions',{model:GROQ_CHAT_MODEL,messages:[{role:'system',content:system},{role:'user',content:question}],temperature:0.2,max_tokens:180},{headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},timeout:15000});
    return res.data?.choices?.[0]?.message?.content?.trim()||null;
  } catch(e){ console.error('General AI error:',e?.message||e); return null; }
}

const SYSTEM_PROMPT = `
You are Induu, an AI student ride-sharing assistant operating in {COUNTRY}.
CURRENT LOCAL CONTEXT:
- Local date: {TODAY_DATE}
- Local time: {TODAY_INFO}
- Draft: {CONTEXT_DRAFT}
Return ONLY valid JSON with these keys:
{
  "role": "rider" | "driver" | "command" | "chat",
  "command": "ONLINE" | "OFFLINE" | "SHOW_REQUESTS" | "TAKE" | "FILTER" | "CLEAR_FILTERS" | "NEXT" | "END_RIDE" | "MY_RIDES" | "CANCEL_RIDE" | "HELP" | null,
  "filter": string | null,
  "takeId": number | null,
  "from": string | null,
  "to": string | null,
  "date": string | null,
  "time": string | null,
  "seats": number | null,
  "bags": number | null
}
RULES:
- Rider means the user needs/wants a ride.
- Driver means the user is offering/driving a vehicle.
- Preserve fields already present in the draft unless the user clearly changes them.
- "need ride tomorrow" means rider + date tomorrow, even when no locations/time are supplied yet.
- "tomorrow at 5pm", "tomorrow 5pm", "Friday at 9am" must preserve both date and time.
- Never turn a general question into a ride request.
- A place name by itself can fill the missing location field in an active draft.
`;

function safeJsonParse(value){ try{ const text=String(value||'').replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```$/i,'').trim(); return JSON.parse(text); } catch(_){ return null; } }

// FIXED: ONLY uses openai/gpt-oss-20b - no llama fallback
async function parseWithAI(message, region, contextDraft){
  const apiKey=process.env.GROQ_API_KEY; if(!apiKey) return {role:'chat'};
  const now=getUserNow(region.timezone); const todayDate=getLocalDateString(new Date(),region.timezone); const todayInfo=`${now.toISOString()} local-wall-clock`;
  const prompt=SYSTEM_PROMPT.replace('{COUNTRY}',region.country).replace('{TODAY_DATE}',todayDate).replace('{TODAY_INFO}',todayInfo).replace('{CONTEXT_DRAFT}',JSON.stringify(contextDraft||{}));
  try{
    const res=await axios.post('https://api.groq.com/openai/v1/chat/completions',{model:GROQ_MODEL,messages:[{role:'system',content:prompt},{role:'user',content:message}],temperature:0,response_format:{type:'json_object'},max_tokens:300},{headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},timeout:15000});
    const data=safeJsonParse(res.data?.choices?.[0]?.message?.content); if(!data) return {role:'chat'};
    if(data.from&&!isValidLocation(data.from)) data.from=null; if(data.to&&!isValidLocation(data.to)) data.to=null;
    if(data.date) data.date=getRealDate(data.date,region.timezone); if(data.time) data.time=getRealTime(data.time,region.timezone);
    if(data.seats!=null) data.seats=Math.max(1,Math.min(6,Number.parseInt(data.seats,10)||1));
    return data;
  } catch(err){
    console.error(`Parser model ${GROQ_MODEL} failed:`,err?.response?.data||err?.message||err);
    return {role:'chat'};
  }
}

function parseDirectCommand(text){
  const l=String(text||'').trim().toLowerCase();
  if(l==='online'||l.startsWith('online ')) return {command:'ONLINE',filter:l.slice(6).trim()||null};
  if(l==='offline') return {command:'OFFLINE'};
  if(['next','more','next page'].includes(l)) return {command:'NEXT'};
  if(['clear','clear filters','clear filter'].includes(l)) return {command:'CLEAR_FILTERS'};
  if(['show requests','show rides','rides'].includes(l)) return {command:'SHOW_REQUESTS'};
  if(['my rides','my ride','myrides'].includes(l)) return {command:'MY_RIDES'};
  if(['cancel ride','cancel','cancel my ride'].includes(l)) return {command:'CANCEL_RIDE'};
  if(['help','menu'].includes(l)) return {command:'HELP'};
  if(['end ride','end trip','complete','complete trip','done','finish','end','end this ride'].includes(l)) return {command:'END_RIDE'};
  const take=l.match(/^take\s+#?(\d+)$/); if(take) return {command:'TAKE',takeId:Number(take[1])};
  if(/^\d+$/.test(l)) return {command:'TAKE',takeId:Number(l)};
  return null;
}

async function handleDirectCommand(cmd, phoneJid, userPhoneKey, normKey, region){
  switch(cmd.command){
    case 'NEXT': {
      const session=getSession(userPhoneKey); if(!session.ridesList?.length) return sendGupshupMessage(phoneJid,'No list active. Say ONLINE to see rides.');
      let nextPage=Number(session.ridesPage||0)+1; const totalPages=Math.max(1,Math.ceil(session.ridesList.length/PAGE_SIZE)); if(nextPage>=totalPages) nextPage=0;
      return sendRidesList(phoneJid,session.ridesList,session.lastTitle,nextPage,region.timezone);
    }
    case 'HELP': return sendGupshupMessage(phoneJid,`*Induu Help*\n• Need a ride: Just type "Juja to Nairobi tomorrow 5pm"\n• Driver: "Online" or "Online Juja" to see rides near you\n• Reply with ride ID to take it, e.g. "12"\n• During trip you can chat directly\n• "End ride" to complete + rate\n• "My rides" - your open rides\n• "Cancel ride" - cancel last open ride\n• "Offline" - go offline\n• "Clear" - clear filters`);
    case 'MY_RIDES': {
      const rides=await RideRequest.findAll({where:{phone:normKey,status:'OPEN'},order:[['createdAt','DESC']]});
      if(!rides.length) return sendGupshupMessage(phoneJid,'You have no open rides. Say "Need a ride" to create one.');
      return sendRidesList(phoneJid,rides,'YOUR OPEN RIDES:',0,region.timezone);
    }
    case 'CANCEL_RIDE': {
      const ride=await RideRequest.findOne({where:{phone:normKey,status:'OPEN'},order:[['createdAt','DESC']]});
      if(!ride) return sendGupshupMessage(phoneJid,'No open ride to cancel.');
      await ride.update({status:'CANCELLED'}); killChatFor(normKey); clearSession(normKey);
      return sendGupshupMessage(phoneJid,`Ride ${ride.id} cancelled.`);
    }
    case 'OFFLINE': {
      const user=await User.getOrCreate(userPhoneKey); await user.setOffline(); clearSession(userPhoneKey); clearRatingSession(userPhoneKey,phoneJid);
      return sendGupshupMessage(phoneJid,`${getTimeGreeting(region.timezone)}! You are now OFFLINE.`);
    }
    case 'ONLINE': {
      const user=await User.getOrCreate(userPhoneKey); let filter=null; let location=user.location||region.defaultCity;
      if(cmd.filter&&cmd.filter.length>1){ filter=cmd.filter.replace(/^in\s+/i,'').trim(); location=filter; }
      await user.setOnline(location,DEFAULT_ONLINE_HOURS); user.filterFrom=filter; await user.save();
      const rides=await RideRequest.findAll({where:{status:'OPEN'},order:[['createdAt','DESC']]});
      const filtered=filter?rides.filter(r=>!isPollutedRide(r)&&(areLocationsNearby(filter,r.from)||areLocationsNearby(filter,r.to))):rides.filter(r=>!isPollutedRide(r));
      await sendGupshupMessage(phoneJid,`ONLINE: ${filter?filter:'All areas'} | Rating: ${Number(user.rating||5).toFixed(1)} ★ (${user.ratingCount||0})`);
      if(filtered.length) await sendRidesList(phoneJid,filtered,'OPEN RIDES:',0,region.timezone);
      else await sendGupshupMessage(phoneJid,filter?`No matching rides near ${filter}. Reply CLEAR to view all.`:"No rides right now. You're online.");
      return;
    }
    case 'CLEAR_FILTERS': {
      const user=await User.getOrCreate(userPhoneKey); user.filterFrom=null; await user.save();
      const rides=await RideRequest.findAll({where:{status:'OPEN'},order:[['createdAt','DESC']]});
      return sendRidesList(phoneJid,rides,'Filters cleared:',0,region.timezone);
    }
    case 'SHOW_REQUESTS': {
      const rides=await RideRequest.findAll({where:{status:'OPEN'},order:[['createdAt','DESC']]});
      return sendRidesList(phoneJid,rides,'OPEN RIDES:',0,region.timezone);
    }
    case 'TAKE': return takeRide(cmd.takeId,phoneJid,normKey,region);
    case 'END_RIDE': return endRideForUser(phoneJid,normKey,region);
    default: return false;
  }
}

async function takeRide(rideId, phoneJid, driverPhone, region){
  if(!rideId) return false;
  const ride=await RideRequest.findByPk(rideId);
  if(!ride){ await sendGupshupMessage(phoneJid,`Ride ${rideId} not found. Try ONLINE.`); return true; }
  if(normalizePhone(ride.phone)===normalizePhone(driverPhone)){ await sendGupshupMessage(phoneJid,`You can't take your own ride ${rideId}.`); return true; }
  if(ride.status!=='OPEN'){ await sendGupshupMessage(phoneJid,`Ride ${rideId} is already taken or closed.`); return true; }
  const [claimed]=await RideRequest.update({status:'TAKEN',driverPhone:normalizePhone(driverPhone)},{where:{id:rideId,status:'OPEN'}});
  if(!claimed){ await sendGupshupMessage(phoneJid,`Ride ${rideId} was just taken by another driver.`); return true; }
  const freshRide=await RideRequest.findByPk(rideId); const riderPhone=normalizePhone(freshRide.phone);
  const driver=await User.getOrCreate(driverPhone); const rider=await User.getOrCreate(riderPhone);
  setActiveChat(riderPhone,driverPhone,freshRide.id);
  await sendGupshupMessage(phoneJid,`MATCHED ${freshRide.id}\n${freshRide.from} → ${freshRide.to} • ${toDisplayDate(freshRide.date,region.timezone)} ${toDisplayTime(freshRide.time)}\nRider: ${getDirectChatLink(riderPhone)} | Rating: ${Number(rider.rating||5).toFixed(1)} ★\nYou can now chat with your rider.\nEND RIDE when done.`);
  await sendGupshupMessage(riderPhone,`DRIVER FOUND ${freshRide.id}\n${freshRide.from} → ${freshRide.to} • ${toDisplayDate(freshRide.date,region.timezone)} ${toDisplayTime(freshRide.time)}\nDriver: ${getDirectChatLink(driverPhone)} | Rating: ${Number(driver.rating||5).toFixed(1)} ★\nYou can now chat with your driver.`);
  return true;
}

async function endRideForUser(phoneJid, userPhoneKey, region){
  const normKey=normalizePhone(userPhoneKey); if(!normKey||endingLocks.has(normKey)) return; endingLocks.add(normKey); setTimeout(()=>endingLocks.delete(normKey),5000);
  try{
    let rideToRate=null; const active=activeChats.get(normKey); if(active?.rideId) rideToRate=await RideRequest.findByPk(active.rideId);
    if(!rideToRate||rideToRate.status!=='TAKEN'){ rideToRate=await RideRequest.findOne({where:{status:'TAKEN',[Op.or]:[{phone:normKey},{driverPhone:normKey}]},order:[['updatedAt','DESC']]}); }
    if(!rideToRate){ await sendGupshupMessage(phoneJid,'No active trip found. Need another? Say: Need a ride'); return; }
    const [updated]=await RideRequest.update({status:'COMPLETED'},{where:{id:rideToRate.id,status:'TAKEN'}}); if(!updated){ await sendGupshupMessage(phoneJid,'This trip was already completed.'); return; }
    const riderPhone=normalizePhone(rideToRate.phone), driverPhone=normalizePhone(rideToRate.driverPhone), otherPhone=normKey===riderPhone?driverPhone:riderPhone;
    killChatFor(normKey); clearSession(normKey); if(!otherPhone){ await sendGupshupMessage(phoneJid,'Trip ended. Chat closed.'); return; }
    setRatingSession(normKey,{rideId:rideToRate.id,other:otherPhone}); setRatingSession(otherPhone,{rideId:rideToRate.id,other:normKey});
    await sendGupshupMessage(phoneJid,`Trip ${rideToRate.id} ended. Thanks for using Induu!\n\nPlease rate your ${normKey===riderPhone?'driver':'rider'}: Reply 1-5 stars (5 = Excellent)`);
    if(otherPhone!==normKey) await sendGupshupMessage(otherPhone,`Trip ${rideToRate.id} ended. Thanks for using Induu!\n\nPlease rate your ${otherPhone===riderPhone?'driver':'rider'}: Reply 1-5 stars (5 = Excellent)`);
  } finally { endingLocks.delete(normKey); }
}

function classifyLocalIntent(text){
  const l=String(text||'').toLowerCase().trim();
  if(/\b(?:need|want|looking for|find me)\b.*\b(?:ride|lift|cab|transport)\b/.test(l)) return 'rider';
  if(/\b(?:give|offer|offering|driving|drive|have)\b.*\b(?:ride|seat|seats|car|vehicle)\b/.test(l)) return 'driver';
  if(/\bfrom\b.+\bto\b/.test(l)&&!/\b(?:give|offer|driving)\b/.test(l)) return 'rider';
  return null;
}

async function handleRideLogic(phoneJid, text, realPhone){
  const rawText=String(text||'').trim(); if(!rawText) return;
  const normKey=canonicalPhone(realPhone,phoneJid); const region=detectUserRegion(normKey); const session=getSession(normKey);
  const ratingSession=getRatingSession(normKey,phoneJid);
  if(ratingSession){
    const rating=parseRating(rawText);
    if(rating){ const newAverage=await addRatingToUser(ratingSession.other,rating); clearRatingSession(normKey,phoneJid,ratingSession.other); await sendGupshupMessage(phoneJid,`Rating saved! You rated ${rating} ★ for trip ${ratingSession.rideId}. New average for them: ${newAverage.toFixed(1)} ★\n\nNeed another? Say: Need a ride`); return; }
    if(/^(skip|no|no thanks)$/i.test(rawText)){ clearRatingSession(normKey,phoneJid,ratingSession.other); await sendGupshupMessage(phoneJid,'Skipped rating. Need another? Say: Need a ride'); return; }
    if(/\b(?:need|want|looking for)\b.*\b(?:ride|lift|cab)\b/i.test(rawText)||/\bfrom\b.+\bto\b/i.test(rawText)){ clearRatingSession(normKey,phoneJid,ratingSession.other); }
    else { await sendGupshupMessage(phoneJid,'Please reply with a rating from 1 to 5, or say skip.'); return; }
  }
  if(activeChats.has(normKey)){
    const lower=rawText.toLowerCase(); const control=/^(end ride|end trip|complete|complete trip|done|finish|online|offline|need a ride|need ride|my rides|cancel ride|help)$/i.test(lower);
    if(!control && await checkAndForwardChat(phoneJid,rawText,normKey)) return;
  }
  const direct=parseDirectCommand(rawText); if(direct){ await handleDirectCommand(direct,phoneJid,normKey,normKey,region); return; }
  const deterministic=extractDeterministicFields(rawText,region.timezone);
  const localIntent=classifyLocalIntent(rawText);
  if(session.draft?.role==='rider'){
    const draft=session.draft;
    const updated=mergeDraft(draft,{date:deterministic.date||draft.date||null,time:deterministic.time||draft.time||null,seats:deterministic.seats||draft.seats||null,bags:deterministic.bags||draft.bags||null});
    if(!updated.from&&isValidLocation(rawText)&&!deterministic.date&&!deterministic.time){ updated.from=rawText; session.draft=updated; await sendGupshupMessage(phoneJid,`Got it, from ${rawText} — where to? Example: ${region.exampleDest}`); return; }
    if(updated.from&&!updated.to&&isValidLocation(rawText)&&!deterministic.date&&!deterministic.time){ if(normalizeLocation(rawText)!==normalizeLocation(updated.from)){ updated.to=rawText; session.draft=updated; if(!updated.time){ await sendGupshupMessage(phoneJid,`Got it, ${updated.from} → ${updated.to}. What time? Example: 5pm or now`); return; } } }
    session.draft=updated;
  }
  let ai=await parseWithAI(rawText,region,session.draft||{});
  const aiRole=ai?.role||localIntent||'chat';
  ai={...ai, date:deterministic.date||ai?.date||session.draft?.date||null, time:deterministic.time||ai?.time||session.draft?.time||null, seats:deterministic.seats||ai?.seats||session.draft?.seats||null, bags:deterministic.bags||ai?.bags||session.draft?.bags||null, role:aiRole };
  if(ai.role==='chat'&&localIntent) ai.role=localIntent;
  if(ai.role==='chat'){ const reply=await answerGeneralQuestion(rawText,region,session.draft?.from); await sendGupshupMessage(phoneJid,reply||"Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip."); return; }
  if(ai.role==='driver'){
    let draft=session.draft?.role==='driver'?session.draft:{role:'driver'}; let from=ai.from||draft.from||null; let to=ai.to||draft.to||null;
    if(!from&&isValidLocation(rawText)&&!isCommandPhrase(rawText)) from=rawText;
    if(!from){ session.draft=mergeDraft(draft,{role:'driver'}); await sendGupshupMessage(phoneJid,`Where are you driving from? Example: ${region.examplePlaces}`); return; }
    if(!to&&draft.from&&isValidLocation(rawText)&&normalizeLocation(rawText)!==normalizeLocation(draft.from)) to=rawText;
    if(!to){ session.draft=mergeDraft(draft,{role:'driver',from}); await sendGupshupMessage(phoneJid,`Got it, driving from ${from} — where to? Example: ${region.exampleDest}`); return; }
    if(normalizeLocation(from)===normalizeLocation(to)){ session.draft=mergeDraft(draft,{role:'driver',from,to:null}); await sendGupshupMessage(phoneJid,`From and to can't be the same (${from}). Where are you driving to?`); return; }
    const user=await User.getOrCreate(normKey); await user.setOnline(from,DEFAULT_ONLINE_HOURS); user.filterFrom=from; await user.save();
    const rides=await RideRequest.findAll({where:{status:'OPEN'},order:[['createdAt','DESC']]});
    const matched=rides.filter(r=>!isPollutedRide(r)&&(areLocationsNearby(from,r.from)||areLocationsNearby(to,r.to)));
    await sendGupshupMessage(phoneJid,matched.length?`You're online: ${from} → ${to} • ${matched.length} matching ride${matched.length===1?'':'s'}`:`You're online: ${from} → ${to} • No matching rides right now.`);
    if(matched.length) await sendRidesList(phoneJid,matched,'MATCHING RIDES:',0,region.timezone);
    clearSession(normKey); return;
  }
  if(ai.role==='rider'){
    const draft=session.draft?.role==='rider'?session.draft:{role:'rider'};
    let from=ai.from||draft.from||null; let to=ai.to||draft.to||null;
    let date=ai.date||draft.date||getLocalDateString(new Date(),region.timezone);
    let time=ai.time||draft.time||null; let seats=ai.seats||draft.seats||null; let bags=ai.bags||draft.bags||null;
    if(/^(need|want)\s+(?:a\s+)?ride(?:\s+tomorrow)?$/i.test(rawText)){
      session.draft=mergeDraft(draft,{role:'rider',date:deterministic.date||date,seats});
      await sendGupshupMessage(phoneJid,`Sure — I've noted ${toDisplayDate(session.draft.date,region.timezone)}. Where are you riding from? Example: ${region.examplePlaces}`); return;
    }
    if(!from){ if(isValidLocation(rawText)&&!deterministic.date&&!deterministic.time&&!isCommandPhrase(rawText)){ from=rawText; } else { session.draft=mergeDraft(draft,{role:'rider',date,time,seats,bags}); await sendGupshupMessage(phoneJid,`Where are you riding from? Example: ${region.examplePlaces}`); return; } }
    if(!to){
      if(isValidLocation(rawText)&&normalizeLocation(rawText)!==normalizeLocation(from)&&!deterministic.date&&!deterministic.time&&!isCommandPhrase(rawText)){ to=rawText; }
      else { session.draft=mergeDraft(draft,{role:'rider',from,date,time,seats,bags}); await sendGupshupMessage(phoneJid,`Got it, from ${from} — where to? Example: ${region.exampleDest}`); return; }
    }
    if(normalizeLocation(from)===normalizeLocation(to)){ session.draft=mergeDraft(draft,{role:'rider',from,to:null,date,time,seats,bags}); await sendGupshupMessage(phoneJid,`From and to can't be the same (${from}). Where to? Example: ${region.exampleDest}`); return; }
    if(!time){ session.draft=mergeDraft(draft,{role:'rider',from,to,date,seats,bags}); await sendGupshupMessage(phoneJid,`Got it, ${from} → ${to} on ${toDisplayDate(date,region.timezone)}. What time? Example: 5pm or now`); return; }
    const rideRequest=await RideRequest.createRide(normKey,{from,to,time,date,seats:seats||1,bags:bags||0});
    await sendGupshupMessage(phoneJid,`RIDE ${rideRequest.id} CREATED\n${rideRequest.from} → ${rideRequest.to}\n${toDisplayDate(rideRequest.date,region.timezone)} at ${toDisplayTime(rideRequest.time)}${rideRequest.seats?` • ${rideRequest.seats} ${rideRequest.seats===1?'person':'people'}`:''}\nAlerting nearby drivers...`);
    const drivers=await User.findAll({where:{isOnline:true,onlineUntil:{[Op.gt]:new Date()}}});
    for(const driver of drivers){
      if(normalizePhone(driver.phone)===normKey) continue;
      const matches=!driver.location||areLocationsNearby(driver.location,rideRequest.from)||areLocationsNearby(driver.location,rideRequest.to);
      if(!matches) continue;
      await sendGupshupMessage(driver.phone,`NEW RIDE MATCH: ${rideRequest.id}\n${rideRequest.from} → ${rideRequest.to}\n${toDisplayDate(rideRequest.date,region.timezone)} at ${toDisplayTime(rideRequest.time)}${rideRequest.seats?` • ${rideRequest.seats} ${rideRequest.seats===1?'person':'people'}`:''}\nReply ${rideRequest.id} to take`);
    }
    clearSession(normKey); return;
  }
  if(ai.role==='command'||ai.command){ await handleDirectCommand({command:ai.command,filter:ai.filter,takeId:ai.takeId},phoneJid,normKey,normKey,region); return; }
  const reply=await answerGeneralQuestion(rawText,region,session.draft?.from);
  await sendGupshupMessage(phoneJid,reply||"Hello! I'm Induu — matching riders and drivers in seconds. Just text me your trip.");
}

function registerMessageHandler(){
  if(!sock) return;
  sock.ev.on('messages.upsert', async ({messages})=>{
    for(const msg of messages||[]){
      try{
        if(!msg?.message||msg.key?.fromMe) continue;
        const remoteJid=msg.key.remoteJid||'';
        if(remoteJid==='status@broadcast'||remoteJid.includes('@g.us')||remoteJid.includes('@broadcast')) continue;
        let text=msg.message.conversation||msg.message.extendedTextMessage?.text||msg.message.imageMessage?.caption||'';
        if(msg.message.buttonsResponseMessage) text=msg.message.buttonsResponseMessage.selectedButtonId||'';
        if(msg.message.templateButtonReplyMessage) text=msg.message.templateButtonReplyMessage.selectedId||'';
        if(msg.message.listResponseMessage) text=msg.message.listResponseMessage.singleSelectReply?.selectedRowId||'';
        if(!text) continue;
        let realPhone=remoteJid;
        if(remoteJid.includes('@lid')){
          if(msg.key.participant&&!msg.key.participant.includes('@lid')) realPhone=msg.key.participant;
          else if(msg.key.remoteJidAlt&&!msg.key.remoteJidAlt.includes('@lid')) realPhone=msg.key.remoteJidAlt;
        }
        const phone=canonicalPhone(realPhone,remoteJid);
        console.log(`MSG ${phone}: ${text}`);
        await queueUserMessage(phone,()=>handleRideLogic(remoteJid,text,phone));
      } catch(err){ if(String(err?.message||'').includes('Bad MAC')) continue; console.error('Message handling error:',err?.stack||err?.message||err); }
    }
  });
}

async function startWhatsApp(){
  if(startingWhatsApp) return; startingWhatsApp=true;
  try{
    if(!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH,{recursive:true});
    const {state,saveCreds}=await useMultiFileAuthState(AUTH_PATH); const {version}=await fetchLatestBaileysVersion();
    sock=makeWASocket({version,auth:state,logger:pino({level:'silent'}),browser:['Induu Universal','Chrome','1.0'],shouldSyncHistoryMessage:()=>false,syncFullHistory:false,markOnlineOnConnect:false,getMessage:async()=>undefined});
    sock.ev.on('creds.update',saveCreds);
    sock.ev.on('connection.update',async update=>{
      const {connection,lastDisconnect,qr}=update; if(qr) qrLast=qr;
      if(connection==='open'){ console.log('WhatsApp Connected'); qrLast=null; startingWhatsApp=false; return; }
      if(connection==='close'){
        const code=lastDisconnect?.error?.output?.statusCode; qrLast=null; sock=null; startingWhatsApp=false;
        if(code===DisconnectReason.loggedOut||code===401){ try{ if(fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH,{recursive:true,force:true}); } catch(e){ console.error('Auth cleanup error:',e?.message||e); } }
        if(!reconnectTimer){ reconnectTimer=setTimeout(()=>{ reconnectTimer=null; startWhatsApp().catch(err=>console.error('Reconnect error:',err)); },5000); }
      }
    });
    registerMessageHandler();
  } catch(err){ startingWhatsApp=false; sock=null; console.error('WhatsApp startup error:',err?.stack||err?.message||err); if(!reconnectTimer){ reconnectTimer=setTimeout(()=>{ reconnectTimer=null; startWhatsApp().catch(e=>console.error('Retry error:',e)); },5000); } }
}

app.get('/ping',(req,res)=>{ res.send('Alive'); });
app.get('/',(req,res)=>{ res.send('Induu LIVE - Advanced Dynamic Rides'); });
app.get('/qr',adminOnly,(req,res)=>{ if(!qrLast) return res.send('<h1>Connected!</h1>'); res.type('text/plain').send(qrLast); });
app.get('/ratings',adminOnly,async (req,res)=>{ try{ const users=await User.findAll({order:[['rating','DESC']]}); res.json(users.map(u=>({phone:normalizePhone(u.phone),rating:Number(u.rating||5),count:Number(u.ratingCount||0)}))); } catch(err){ res.status(500).json({error:'Failed to load ratings'}); } });
app.post('/clearall',adminOnly,async (req,res)=>{ try{ await RideRequest.destroy({where:{}}); await RideOffer.destroy({where:{}}); activeChats.clear(); userSessions.clear(); ratingSessions.clear(); res.send('All rides deleted + active memory cleared'); } catch(err){ console.error(err); res.status(500).send('Failed to clear data'); } });
app.post('/cleardb',adminOnly,async (req,res)=>{ try{ await sequelize.sync({force:true}); activeChats.clear(); userSessions.clear(); ratingSessions.clear(); res.send('Full DB wiped'); } catch(err){ console.error(err); res.status(500).send('Failed to wipe DB'); } });

async function bootstrap(){
  try{
    await sequelize.authenticate(); await sequelize.sync({alter:true});
    console.log('DB connected and synchronized');
  } catch(err){ console.error('DB startup error:',err?.stack||err?.message||err); }
  startWhatsApp().catch(err=>console.error('WhatsApp boot error:',err));
}

const server=app.listen(PORT,()=>{ console.log(`Induu Running on ${PORT}`); });
setInterval(async ()=>{ try{ await RideRequest.clearExpired(); await User.clearExpiredOnline(); } catch(err){ console.error('Maintenance error:',err?.message||err); } },5*60*1000);
process.on('SIGTERM',async()=>{ try{ if(sock) sock.end(undefined); } catch(_){} server.close(()=>process.exit(0)); });
process.on('SIGINT',async()=>{ try{ if(sock) sock.end(undefined); } catch(_){} server.close(()=>process.exit(0)); });

bootstrap();
