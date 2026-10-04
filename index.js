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

function getSession(phone) {
    if (!userSessions[phone]) userSessions[phone] = { draft: {}, lastUpdated: Date.now() };
    return userSessions[phone];
}
function clearSession(phone) { delete userSessions[phone]; }

function getNairobiNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })); }
function getTimeGreeting() {
    const h = getNairobiNow().getHours();
    if (h >= 5 && h < 12) return "Good morning";
    if (h >= 12 && h < 15) return "Good afternoon";
    if (h >= 15 && h < 19) return "Good evening";
    return "Hello";
}
function getRealDate(aiDate) {
    const now = getNairobiNow();
    if (!aiDate) return now.toISOString().split('T')[0];
    const s = aiDate.toString().toLowerCase();
    if (['today','now','null','asap','leo','sai','sahii'].includes(s)) return now.toISOString().split('T')[0];
    if (['tomorrow','kesho'].includes(s)) { let t = new Date(now); t.setDate(now.getDate()+1); return t.toISOString().split('T')[0]; }
    return aiDate;
}
function getRealTime(aiTime) {
    const now = getNairobiNow();
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    if (!aiTime) return `${hh}:${mm}`;
    let l = aiTime.toString().toLowerCase().trim();
    if (['now','asap','sasa','sai','sahii','saa hii','now now'].includes(l)) return `${hh}:${mm}`;
    let m = l.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (m) { let h=parseInt(m[1]); let min=parseInt(m[2]||'0'); let ap=m[3]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`; }
    return `${hh}:${mm}`;
}
function toDisplayTime(t) {
    if (!t || t==='Flexible') return 'now';
    let [h,m] = t.split(':').map(Number);
    if (isNaN(h)) return t;
    let ap = h>=12?'PM':'AM'; let hh = h%12||12;
    return `${hh}:${String(m||0).padStart(2,'0')} ${ap}`;
}
function getDirectChatLink(jid) {
    let num = jid.split('@')[0].replace(/[^0-9]/g,'');
    if (num.startsWith('0')) num='254'+num.slice(1);
    if (!num.startsWith('254') && num.length===9) num='254'+num;
    return `https://wa.me/${num}`;
}
function parseTimeQuick(input) {
    if (!input) return null;
    let t = input.toLowerCase().trim();
    const now = getNairobiNow();
    if (['now','sai','sahii','saa hii','sasa','sasa hivi','now now','asap'].includes(t)) return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    if (t==='kesho' || t==='tomorrow') return '09:00';
    let m = t.match(/^(\d{1,2})(\s*(am|pm))?$/);
    if (m) { let h=parseInt(m[1]); let ap=m[3]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:00`; }
    let m2 = t.match(/(\d{1,2}):(\d{2})(\s*(am|pm))?/);
    if (m2) { let h=parseInt(m2[1]); let min=parseInt(m2[2]); let ap=m2[4]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`; }
    return null;
}
function isSimpleLocation(txt) {
    const t = txt.toLowerCase().trim();
    const block = ['hi','hey','hello','sasa','mambo','niaje','need','ride','offer','driver','car','online','offline','filter','clear','next','now','sai','kesho','today','thanks','asante','ok','okay','need offer','offer ride','need to offer','i need','available','requests','show','all','see','my','trip','accept','take'];
    if (block.some(b => t===b || t.startsWith(b+' ') || t.includes(b))) return false;
    if (t.length < 3 || t.length > 25) return false;
    if (/^\d+$/.test(t)) return false;
    if (parseTimeQuick(t)) return false;
    if (!/^[a-zA-Z\s]+$/.test(t)) return false;
    if (t.split(' ').length > 3) return false;
    return true;
}

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ["Rideschat","Chrome","1.0"], shouldSyncHistoryMessage: () => false, syncFullHistory: false, markOnlineOnConnect: false, getMessage: async () => undefined });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrLast = qr;
        if (connection==='open') { console.log('WA Connected'); qrLast=null; }
        if (connection==='close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            qrLast=null; sock=null;
            if (code===DisconnectReason.loggedOut || code===401) { if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH,{recursive:true,force:true}); }
            setTimeout(startWhatsApp,5000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages?.[0]) return;
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const remoteJid = msg.key.remoteJid || "";
            if (remoteJid==='status@broadcast' || remoteJid.includes('@g.us')) return;
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

var SYSTEM_PROMPT = `You are Rideschat Kenya. Current: {TODAY_INFO} [{TODAY_DATE}] {GREETING}. Draft: {CONTEXT_DRAFT}
Classify:
1. CHITCHAT: Hi,How are you,Weather -> {"role":"chat"}
2. RIDE: Extract from/to/date/time
3. COMMAND: TAKE 1,ONLINE,OFFLINE,FILTER Juja,CLEAR FILTERS
Return ONLY JSON:
{"role":"rider|driver|command|chat","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|FILTER|CLEAR_FILTERS|NEXT|null","filter":string|null,"takeId":number|null,"from":string|null,"to":string|null,"date":"today|tomorrow|null","time":"HH:MM|now|null","seats":number|null}
`;

async function parseWithAI(msg, contextDraft={}) {
    var now = getNairobiNow();
    var todayInfo = now.toLocaleDateString('en-US',{weekday:'long'})+" "+now.toISOString().split('T')[0]+" "+now.toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'});
    var greeting = getTimeGreeting();
    var prompt = SYSTEM_PROMPT.replaceAll("{TODAY_INFO}",todayInfo).replaceAll("{TODAY_DATE}",now.toISOString().split('T')[0]).replaceAll("{GREETING}",greeting).replaceAll("{CONTEXT_DRAFT}",JSON.stringify(contextDraft));
    var apiKey = process.env.GROQ_API_KEY;
    var models = ["openai/gpt-oss-20b","llama-3.3-70b-versatile"];
    for (var i=0;i<models.length;i++) {
        try {
            var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
                { model: models[i], messages: [{role:"system",content:prompt},{role:"user",content:msg}], temperature:0.2, response_format:{type:"json_object"} },
                { headers:{ "Authorization":`Bearer ${apiKey}` } }
            );
            var data = JSON.parse(res.data.choices[0].message.content.trim());
            if (data.date) data.date=getRealDate(data.date);
            if (data.time) data.time=getRealTime(data.time);
            return data;
        } catch(e) { if (i===models.length-1) throw e; }
    }
}
async function answerGeneralQuestion(q, loc="Juja") {
    if (!q || q.trim().length <= 2) return null;
    if (/^\d+$/.test(q.trim())) return null;
    if (['accept','offer ride','okay','ok'].includes(q.trim().toLowerCase())) return null;
    try {
        const greeting = getTimeGreeting();
        let sys = `You are Rideschat, brief. ${greeting}. Location ${loc}. Reply 1-2 lines max, no emojis. If greeting: "${greeting}! Where are you riding from today?"`;
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b", messages: [{role:"system",content:sys},{role:"user",content:q}], temperature:0.6
        }, { headers:{ "Authorization":`Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch(e) { return null; }
}

async function sendGupshupMessage(toJid, txt) {
    if (!toJid||!sock) return;
    try { let jid = toJid.includes('@')?toJid:toJid.replace('+','').trim()+'@s.whatsapp.net'; await sock.sendMessage(jid,{text:txt}); } catch(e){console.error(e.message);}
}
async function sendRidesList(toJid, rides, title="RIDES:") {
    if (!rides || rides.length===0) { await sendGupshupMessage(toJid, `${title}\nNo rides now. Stay ONLINE or FILTER`); return; }
    let firstId = rides[0].id;
    let list = rides.slice(0,10).map(r => `#${r.id} ${r.from?.split(',')[0].substring(0,15)} -> ${r.to?.split(',')[0].substring(0,15)} | ${r.seats||1}p | ${toDisplayTime(r.time)}`).join('\n');
    await sendGupshupMessage(toJid, `${title}\n${list}\n\nReply ${firstId} or TAKE ${firstId} to accept`);
}

// FIXED Chat bridge - won't leak to old driver
async function checkAndForwardChat(phoneJid, text, realPhone) {
    try {
        const userPhoneKey = realPhone || phoneJid;
        const lower = text.toLowerCase().trim();
        // Block commands, short words, emojis, locations
        if (lower.length <= 3) return false;
        if (['take','filter','clear','online','offline','need','show','next','delete','end ride','accept','offer','can do','available','okay','ok','thanks','asante','where','what','when','hi','hello'].some(b => lower===b || lower.startsWith(b+' ') || lower.startsWith(b))) ) return false;
        if (/^\d+$/.test(lower)) return false;
        if (lower.includes('👍') || lower.includes('❤️') || lower.includes('😍') || lower.includes('🙏')) return false;

        let chat = activeChats[userPhoneKey];
        if (!chat) return false;

        let ride = await RideRequest.findById(chat.rideId);
        if (!ride || ride.status!=='TAKEN') {
            delete activeChats[userPhoneKey];
            if (chat.with) delete activeChats[chat.with];
            return false;
        }
        const twoHoursAgo = new Date(Date.now() - 2*60*60*1000);
        if (new Date(ride.updatedAt) < twoHoursAgo) {
            delete activeChats[userPhoneKey];
            if (chat.with) delete activeChats[chat.with];
            return false;
        }

        let sender = ride.phone===userPhoneKey? "Rider" : "Driver";
        await sendGupshupMessage(chat.with, `${sender} #${chat.rideId}: ${text}`);
        await sendGupshupMessage(phoneJid, `Sent to ${sender.toLowerCase()}`);
        return true;
    } catch(e){ console.error("chat bridge err", e.message); return false; }
}

async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        const userPhoneKey = realPhone||phoneJid;

        // 1. END RIDE - always clear
        if (['end ride','complete','trip done','cancel ride','done','finished'].includes(lowerText) || lowerText.includes('end ride')) {
            for (let k in activeChats) { if (k===userPhoneKey || activeChats[k]?.with===userPhoneKey) delete activeChats[k]; }
            try {
                let r = await RideRequest.findOne({where:{[Op.or]:[{phone:userPhoneKey},{driverPhone:userPhoneKey}], status:'TAKEN'}, order:[['updatedAt','DESC']]});
                if(r){ await r.updateStatus('COMPLETED'); await r.save(); }
            } catch(e){}
            clearSession(userPhoneKey);
            await sendGupshupMessage(phoneJid, "Trip ended. Thanks for using Rideschat! Rate 1-5.\nNeed another? Say: Need a ride");
            return;
        }

        // 2. NEW SESSION commands - KILL old chat BEFORE bridge
        const isNewStart = lowerText==='offline' || lowerText.startsWith('offline') || lowerText==='online' || lowerText.startsWith('online') || lowerText==='need a ride' || lowerText==='need ride' || lowerText.startsWith('need a ride') || lowerText.startsWith('filter ') || lowerText==='clear filters' || lowerText==='clear filter';
        if (isNewStart) {
            for (let k in activeChats) { if (k===userPhoneKey || activeChats[k]?.with===userPhoneKey) delete activeChats[k]; }
            if (lowerText.includes('need a ride') || lowerText==='need ride') clearSession(userPhoneKey);
        } else {
            // 3. Only try bridge if NOT a new command
            if (['okay','ok','cool','thx','thanks','asante'].some(w=>lowerText.includes(w)) && lowerText.length < 10) return;
            if (await checkAndForwardChat(phoneJid, text, realPhone)) return;
        }

        // 4. Single number TAKE with self-check
        if (/^\d+$/.test(lowerText)) {
            let rideId = parseInt(lowerText,10);
            let ride = await RideRequest.findById(rideId);
            if (!ride) { await sendGupshupMessage(phoneJid, `Ride #${rideId} not found. Try ONLINE to see rides`); return; }
            if (ride.phone===userPhoneKey) { await sendGupshupMessage(phoneJid, `You can't take your own ride #${rideId}`); return; }
            if (ride.status==='OPEN') {
                await ride.updateStatus("TAKEN");
                ride.driverPhone = userPhoneKey;
                await ride.save();
                activeChats[ride.phone] = { with: userPhoneKey, rideId: ride.id };
                activeChats[userPhoneKey] = { with: ride.phone, rideId: ride.id };
                let riderLink = getDirectChatLink(ride.phone);
                let driverLink = getDirectChatLink(userPhoneKey);
                await sendGupshupMessage(phoneJid, `MATCHED #${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\n\nRider: ${riderLink} (tap to open WhatsApp)\nChat here - type message\nEND RIDE when done`);
                await sendGupshupMessage(ride.phone, `DRIVER FOUND #${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${driverLink} (tap to chat)\nReply here to chat with driver`);
                return;
            } else if (ride.status==='TAKEN') {
                await sendGupshupMessage(phoneJid, `Ride #${rideId} already taken`);
                return;
            }
        }

        if (lowerText.includes('offer') && lowerText.includes('ride')) {
            let u = await User.getOrCreate(userPhoneKey);
            let loc = "Juja";
            const m = lowerText.match(/from\s+([a-z]+)/);
            if (m) loc = m[1];
            await u.setOnline(loc,2);
            let nearby = await RideRequest.getNearby(u.location);
            await sendGupshupMessage(phoneJid, `ONLINE: ${u.location} | ${u.rating.toFixed(1)}`);
            await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES NEAR ${u.location.toUpperCase()}:`);
            clearSession(userPhoneKey);
            return;
        }
        if (lowerText.includes('see all') || lowerText.includes('available rides') || lowerText.includes('show requests') || lowerText.includes('need to see')) {
            let nearby = await RideRequest.getNearby("Juja");
            await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES IN JUJA:`);
            clearSession(userPhoneKey);
            return;
        }

        if (lowerText.startsWith('filter ')) {
            let filterLoc = text.substring(7).trim();
            let u = await User.getOrCreate(userPhoneKey);
            u.filterFrom=filterLoc; await u.save();
            let nearby = await RideRequest.getNearby(filterLoc);
            await sendRidesList(phoneJid, nearby, `Filter ${filterLoc} | ${nearby.length} rides`);
            return;
        }
        if (lowerText==='clear filters' || lowerText==='clear filter') {
            let u = await User.getOrCreate(userPhoneKey); u.filterFrom=null; await u.save();
            let nearby = await RideRequest.getNearby(u.location||'Juja');
            await sendRidesList(phoneJid, nearby, `Filters cleared - ${nearby.length} rides`);
            return;
        }

        const takeMatch = lowerText.match(/^take[_\s]*(\d+)$/i);
        const offerMatch = lowerText.match(/(?:offer|can do|i can).*?#?(\d+)/);

        if (offerMatch &&!takeMatch) {
            let rideId = parseInt(offerMatch[1],10);
            let ride = await RideRequest.findById(rideId);
            if (!ride || ride.status!=='OPEN') { await sendGupshupMessage(phoneJid, `Ride #${rideId} not available`); return; }
            if (ride.phone===userPhoneKey) { await sendGupshupMessage(phoneJid, `You can't offer on your own ride #${rideId}`); return; }
            let driverLink = getDirectChatLink(userPhoneKey);
            await sendGupshupMessage(ride.phone, `Driver offer for #${ride.id} ${ride.from} -> ${ride.to}\nDriver says: "${text}"\nDriver chat: ${driverLink}\n\nReply ACCEPT ${ride.id} to accept`);
            await sendGupshupMessage(phoneJid, `Offer sent to rider #${ride.id}. Rider chat: ${getDirectChatLink(ride.phone)}`);
            let s = getSession(userPhoneKey); s.draft.lastOffer = rideId; return;
        }

        const acceptMatch = lowerText.match(/^accept[_\s]*(\d+)$/i);
        if (acceptMatch) {
            let rideId = parseInt(acceptMatch[1],10);
            let ride = await RideRequest.findById(rideId);
            if (ride && ride.phone===userPhoneKey && ride.status==='OPEN') {
                let drivers = await User.getOnlineNearby(ride.from);
                if (drivers.length>0) {
                    let driver = drivers[0];
                    ride.driverPhone = driver.phone;
                    await ride.updateStatus("TAKEN");
                    await ride.save();
                    activeChats[ride.phone] = { with: driver.phone, rideId: ride.id };
                    activeChats[driver.phone] = { with: ride.phone, rideId: ride.id };
                    await sendGupshupMessage(driver.phone, `Rider ACCEPTED #${ride.id} ${ride.from} -> ${ride.to}\nChat: ${getDirectChatLink(ride.phone)}`);
                    await sendGupshupMessage(ride.phone, `Accepted! Driver ${getDirectChatLink(driver.phone)} will contact you.`);
                } else {
                    await sendGupshupMessage(phoneJid, `No driver available for #${rideId} now.`);
                }
                return;
            }
        }

        if (takeMatch) {
            let rideId = parseInt(takeMatch[1],10);
            let ride = await RideRequest.findById(rideId);
            if (!ride) { await sendGupshupMessage(phoneJid, `Ride #${rideId} not found`); return; }
            if (ride.phone===userPhoneKey) { await sendGupshupMessage(phoneJid, `You can't take your own ride #${rideId}`); return; }
            if (ride.status==='OPEN') {
                await ride.updateStatus("TAKEN");
                ride.driverPhone = userPhoneKey;
                await ride.save();
                activeChats[ride.phone] = { with: userPhoneKey, rideId: ride.id };
                activeChats[userPhoneKey] = { with: ride.phone, rideId: ride.id };
                let riderLink = getDirectChatLink(ride.phone);
                let driverLink = getDirectChatLink(userPhoneKey);
                await sendGupshupMessage(phoneJid, `MATCHED #${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\n\nRider: ${riderLink} (tap to open WhatsApp)\nChat here - type message\nEND RIDE when done`);
                await sendGupshupMessage(ride.phone, `DRIVER FOUND #${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${driverLink} (tap to chat)\nReply here to chat with driver`);
            } else {
                await sendGupshupMessage(phoneJid, `Ride #${takeMatch[1]} already taken`);
                let nearby = await RideRequest.getNearby("Juja");
                await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES:`);
            }
            return;
        }

        var user = await User.getOrCreate(userPhoneKey);
        var session = getSession(userPhoneKey);

        // Interactive AI helper
        async function askInteractiveNext(draft, step, originalText) {
            try {
                const sys = `You are Rideschat, friendly. Draft: ${JSON.stringify(draft)}. Step: ${step}. Reply 1 short conversational line. Examples: "Okay, from Machakos — where to?" "Machakos to Thika, nice — what time? Now or later?" Keep under 15 words.`;
                const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
                    model: "openai/gpt-oss-20b",
                    messages: [{role:"system",content:sys},{role:"user",content:`User said: ${originalText}. Step ${step}`}],
                    temperature:0.7, max_tokens:50
                }, { headers:{ "Authorization":`Bearer ${process.env.GROQ_API_KEY}` } });
                return res.data.choices[0].message.content.trim();
            } catch(e) {
                if(step==='ask_to') return `Okay, from ${draft.from} — where to?`;
                if(step==='ask_time') return `Got it, ${draft.from} → ${draft.to}. What time? Reply Now or 9 AM`;
                return `Okay, ${draft.from} → ${draft.to} — what time?`;
            }
        }

        if (!session.draft.from && isSimpleLocation(text)) {
            session.draft.from = text.trim(); session.draft.role='rider';
            let reply = await askInteractiveNext(session.draft, 'ask_to', text);
            await sendGupshupMessage(phoneJid, reply);
            return;
        }
        if (session.draft.from &&!session.draft.to && isSimpleLocation(text)) {
            session.draft.to = text.trim();
            let reply = await askInteractiveNext(session.draft, 'ask_time', text);
            await sendGupshupMessage(phoneJid, reply);
            return;
        }
        if (session.draft.from && session.draft.to &&!session.draft.time) {
            let qt = parseTimeQuick(lowerText);
            if (qt) {
                session.draft.time = qt; session.draft.date = getRealDate('today');
                await sendGupshupMessage(phoneJid, `Perfect, ${session.draft.from} → ${session.draft.to} at ${toDisplayTime(qt)} — creating your ride...`);
                var rr = await RideRequest.createCustom(userPhoneKey, session.draft);
                await sendGupshupMessage(phoneJid, `RIDE #${rr.id} CREATED\n${rr.from} → ${rr.to}\n${toDisplayTime(rr.time)} Today\nAlerting nearby drivers...`);
                var drvs = await User.getOnlineNearby(rr.from);
                var clean = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
                var filtered = drvs.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean;});
                for (let d of filtered) await sendGupshupMessage(d.phone, `#${rr.id} ${rr.from} → ${rr.to} | ${toDisplayTime(rr.time)}\nReply ${rr.id} or TAKE ${rr.id}`);
                clearSession(userPhoneKey); return;
            } else {
                let reply = await askInteractiveNext(session.draft, 'ask_time', text);
                await sendGupshupMessage(phoneJid, reply);
                return;
            }
        }

        var ai = await parseWithAI(text, session.draft);
        if (ai.role==='chat') {
            let reply = await answerGeneralQuestion(text, user.location||session.draft.from||"Juja");
            if (!reply) {
                if (/^\d+$/.test(text.trim()) || text.trim().toLowerCase() === 'accept') return;
                reply = `${getTimeGreeting()}! Where are you riding from today?`;
            }
            await sendGupshupMessage(phoneJid, reply);
            return;
        }

        let newFrom = ai.from||null; let newTo = ai.to||null;
        if (session.draft.from &&!session.draft.to && newFrom &&!newTo) { newTo=newFrom; newFrom=session.draft.from; }
        session.draft = { role: ai.role||session.draft.role||'rider', from: newFrom||session.draft.from||null, to: newTo||session.draft.to||null, date: ai.date||session.draft.date||null, time: ai.time||session.draft.time||null, bags:0 };

        if (ai.role==='command') {
            if (ai.command==='ONLINE') {
                await user.setOnline(ai.from||session.draft.from||"Juja",2);
                var nearby = await RideRequest.getNearby(user.location);
                await sendGupshupMessage(phoneJid, `ONLINE: ${user.location} | ${user.rating.toFixed(1)}`);
                await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES NEAR ${user.location.toUpperCase()}:`);
            }
            if (ai.command==='OFFLINE') { await user.setOffline(); clearSession(userPhoneKey); await sendGupshupMessage(phoneJid, `OFFLINE - ${getTimeGreeting()}!`); }
            if (ai.command==='SHOW_REQUESTS') {
                var nearby2 = await RideRequest.getNearby("Juja");
                await sendRidesList(phoneJid, nearby2, `${nearby2.length} RIDES IN JUJA:`);
            }
            return;
        }

        if (session.draft.role==='rider' && (!session.draft.from||!session.draft.to)) {
            if (!session.draft.from) {
                let r = await askInteractiveNext(session.draft, 'ask_from', text);
                await sendGupshupMessage(phoneJid, r);
            } else {
                let r = await askInteractiveNext(session.draft, 'ask_to', text);
                await sendGupshupMessage(phoneJid, r);
            }
            return;
        }
        if (session.draft.role==='rider' &&!session.draft.time) {
            let r = await askInteractiveNext(session.draft, 'ask_time', text);
            await sendGupshupMessage(phoneJid, r);
            return;
        }
        if (session.draft.role==='rider') {
            var rideReq2 = await RideRequest.createCustom(userPhoneKey, session.draft);
            await sendGupshupMessage(phoneJid, `RIDE #${rideReq2.id} CREATED\n${rideReq2.from} → ${rideReq2.to}\n${toDisplayTime(rideReq2.time)} Today\nAlerting nearby drivers...`);
            var drivers2 = await User.getOnlineNearby(rideReq2.from);
            var clean2 = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
            var f2 = drivers2.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean2;});
            for (let d of f2) await sendGupshupMessage(d.phone, `#${rideReq2.id} ${rideReq2.from} → ${rideReq2.to} | ${toDisplayTime(rideReq2.time)}\nReply ${rideReq2.id} or TAKE ${rideReq2.id}`);
            clearSession(userPhoneKey); return;
        }
    } catch(err){ console.error('Error:',err.stack||err.message); }
}

setInterval(async()=>{ try{ if (RideRequest.clearExpired) await RideRequest.clearExpired(); if (RideOffer.clearExpired) await RideOffer.clearExpired(); }catch(e){} },15*60*1000);

app.get('/qr',(req,res)=>{ if (!qrLast) return res.send("<h1>Connected!</h1>"); var qrImage="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data="+encodeURIComponent(qrLast); res.send(`<h1>Scan</h1><img src='${qrImage}'/>`); });
app.get('/ping',(req,res)=>{ res.send("Alive"); });
app.get('/',(req,res)=>{ res.send("Rideschat LIVE - /qr"); });
app.get('/clearall', async (req,res)=>{ await RideRequest.destroy({ where: {} }); await RideOffer.destroy({ where: {} }); res.send("All rides deleted"); });
app.get('/cleardb', async (req,res)=>{ await sequelize.sync({ force: true }); res.send("Full DB wiped, IDs reset to 1"); });

var PORT = process.env.PORT||10000;
app.listen(PORT,()=>{ console.log("Running on "+PORT); });
