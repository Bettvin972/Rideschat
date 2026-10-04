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
    // FIXED: block accept, offer, take, numbers from being location
    const block = ['hi','hey','hello','sasa','mambo','niaje','need','ride','offer','driver','car','online','offline','filter','clear','next','now','sai','kesho','today','thanks','asante','ok','okay','need offer','offer ride','need to offer','i need','available','requests','show','all','see','my','trip','accept','take'];
    if (block.some(b => t===b || t.startsWith(b+' ') || t.includes(b))) return false;
    if (t.length < 3 || t.length > 25) return false;
    if (/^\d+$/.test(t)) return false;
    if (parseTimeQuick(t)) return false;
    if (!/^[a-zA-Z\s]+$/.test(t)) return false;
    if (t.split(' ').length > 3) return false;
    return true;
}

// WhatsApp Start
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

// AI
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
    // FIXED: ignore numbers like "22"
    if (!q || q.trim().length <= 2) return null;
    if (/^\d+$/.test(q.trim())) return null;
    if (q.trim().toLowerCase() === 'accept' || q.trim().toLowerCase() === 'offer ride') return null;
    try {
        const greeting = getTimeGreeting();
        let sys = `You are Rideschat, brief. ${greeting}. Location ${loc}. Reply 1-2 lines max, no emojis. If greeting: "${greeting}! Karibu Rideschat. Say: Niko Juja nataka kuenda Thika sai".`;
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b", messages: [{role:"system",content:sys},{role:"user",content:q}], temperature:0.6
        }, { headers:{ "Authorization":`Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch(e) { return null; }
}

// Senders
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

// Chat bridge - SAFE VERSION
async function checkAndForwardChat(phoneJid, text, realPhone) {
    try {
        const userPhoneKey = realPhone || phoneJid;
        const lower = text.toLowerCase().trim();
        const block = ['take','filter','clear','online','offline','need','show','next','delete','end ride','accept','offer','can do','available'];
        if (block.some(b => lower.startsWith(b))) return false;
        if (/^\d+$/.test(lower)) return false; // numbers handled in main logic
        let chat = activeChats[userPhoneKey];
        if (!chat) {
            const threeHoursAgo = new Date(Date.now() - 3*60*60*1000);
            let ride = null;
            try {
                ride = await RideRequest.findOne({ where: { status:'TAKEN', updatedAt:{[Op.gt]:threeHoursAgo}, [Op.or]:[{phone:userPhoneKey},{driverPhone:userPhoneKey}] }, order:[['updatedAt','DESC']] });
            } catch(e){
                // fallback if driverPhone column missing
                ride = await RideRequest.findOne({ where: { phone:userPhoneKey, status:'TAKEN', updatedAt:{[Op.gt]:threeHoursAgo} }, order:[['updatedAt','DESC']] });
            }
            if (ride && ride.driverPhone) {
                let other = ride.phone===userPhoneKey? ride.driverPhone : ride.phone;
                if (other) { chat={with:other, rideId:ride.id}; activeChats[userPhoneKey]=chat; activeChats[other]={with:userPhoneKey, rideId:ride.id}; }
            }
        }
        if (chat?.with) {
            let ride = await RideRequest.findById(chat.rideId);
            let sender = ride && ride.phone===userPhoneKey? "Rider" : "Driver";
            await sendGupshupMessage(chat.with, `${sender} #${chat.rideId}: ${text}`);
            await sendGupshupMessage(phoneJid, `Sent to ${sender.toLowerCase()}`);
            return true;
        }
        return false;
    } catch(e){ console.error("chat bridge err", e.message); return false; }
}

// Main logic
async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        const userPhoneKey = realPhone||phoneJid;

        if (['okay','ok','cool','thx','thanks','asante'].includes(lowerText)) return;

        // END RIDE
        if (['end ride','complete','trip done','cancel ride','done'].includes(lowerText)) {
            for (let k in activeChats) { if (k===userPhoneKey || activeChats[k]?.with===userPhoneKey) delete activeChats[k]; }
            await sendGupshupMessage(phoneJid, "Trip ended. Thanks for using Rideschat! Rate 1-5.\nNeed another? Say: Need ride");
            return;
        }

        // FIXED: Handle single number like "22" or "1" as TAKE
        if (/^\d+$/.test(lowerText)) {
            let rideId = parseInt(lowerText,10);
            let ride = await RideRequest.findById(rideId);
            if (ride && ride.status==='OPEN') {
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
            } else if (ride && ride.status==='TAKEN') {
                await sendGupshupMessage(phoneJid, `Ride #${rideId} already taken`);
                return;
            }
            // if ride not found, don't fall through to AI
            await sendGupshupMessage(phoneJid, `Ride #${rideId} not found. Try ONLINE to see rides`);
            return;
        }

        // Forward chat if in active ride
        if (await checkAndForwardChat(phoneJid, text, realPhone)) return;

        // Driver wants to see all / offer flow
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
        if (lowerText.includes('need a ride') || lowerText==='need ride') clearSession(userPhoneKey);

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

        // OFFER - FIXED status to OPEN
        if (offerMatch &&!takeMatch) {
            let rideId = parseInt(offerMatch[1],10);
            let ride = await RideRequest.findById(rideId);
            if (!ride || ride.status!=='OPEN') { await sendGupshupMessage(phoneJid, `Ride #${rideId} not available`); return; }
            let driverLink = getDirectChatLink(userPhoneKey);
            await sendGupshupMessage(ride.phone, `Driver offer for #${ride.id} ${ride.from} -> ${ride.to}\nDriver says: "${text}"\nDriver chat: ${driverLink}\n\nReply ACCEPT ${ride.id} to accept`);
            await sendGupshupMessage(phoneJid, `Offer sent to rider #${ride.id}. Rider chat: ${getDirectChatLink(ride.phone)}`);
            let s = getSession(userPhoneKey); s.draft.lastOffer = rideId; return;
        }

        // ACCEPT OFFER - FIXED status to OPEN
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

        // TAKE - FIXED status to OPEN
        if (takeMatch) {
            let rideId = parseInt(takeMatch[1],10);
            let ride = await RideRequest.findById(rideId);
            if (ride && ride.status==='OPEN') {
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

        // Quick FROM / TO / TIME bypass AI
        if (!session.draft.from && isSimpleLocation(text)) {
            session.draft.from = text.trim(); session.draft.role='rider';
            await sendGupshupMessage(phoneJid, `FROM: ${session.draft.from} saved\n\nWHERE TO? Eg: Thika`);
            return;
        }
        if (session.draft.from &&!session.draft.to && isSimpleLocation(text)) {
            session.draft.to = text.trim();
            await sendGupshupMessage(phoneJid, `TO: ${session.draft.to} saved\n\nWHAT TIME? Reply: Now / 9 / 3 PM`);
            return;
        }
        if (session.draft.from && session.draft.to &&!session.draft.time) {
            let qt = parseTimeQuick(lowerText);
            if (qt) {
                session.draft.time = qt; session.draft.date = getRealDate('today');
                var rr = await RideRequest.createCustom(userPhoneKey, session.draft);
                await sendGupshupMessage(phoneJid, `RIDE #${rr.id} CREATED\n${rr.from} -> ${rr.to}\n${toDisplayTime(rr.time)} Today\nAlerting drivers...`);
                var drvs = await User.getOnlineNearby(rr.from);
                var clean = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
                var filtered = drvs.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean;});
                for (let d of filtered) await sendGupshupMessage(d.phone, `#${rr.id} ${rr.from} -> ${rr.to} | ${toDisplayTime(rr.time)}\nReply ${rr.id} or TAKE ${rr.id}`);
                clearSession(userPhoneKey); return;
            }
        }

        var ai = await parseWithAI(text, session.draft);

        if (ai.role==='chat') {
            let reply = await answerGeneralQuestion(text, user.location||session.draft.from||"Juja");
            if (!reply) {
                // if AI chat but we filtered it, ignore
                if (/^\d+$/.test(text.trim()) || text.trim().toLowerCase() === 'accept') return;
                reply = `${getTimeGreeting()}! Karibu Rideschat. Say: Niko Juja nataka kuenda Thika sai`;
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
            if (!session.draft.from) await sendGupshupMessage(phoneJid, `WHERE FROM? Eg: Juja`);
            else await sendGupshupMessage(phoneJid, `WHERE TO? You are in ${session.draft.from}, where to? Eg: Thika`);
            return;
        }
        if (session.draft.role==='rider' &&!session.draft.time) { await sendGupshupMessage(phoneJid, `WHAT TIME? Reply: Now / Sai / 9 / 3 PM`); return; }
        if (session.draft.role==='rider') {
            var rideReq2 = await RideRequest.createCustom(userPhoneKey, session.draft);
            await sendGupshupMessage(phoneJid, `RIDE #${rideReq2.id} CREATED\n${rideReq2.from} -> ${rideReq2.to}\n${toDisplayTime(rideReq2.time)} Today\nAlerting drivers...`);
            var drivers2 = await User.getOnlineNearby(rideReq2.from);
            var clean2 = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
            var f2 = drivers2.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean2;});
            for (let d of f2) await sendGupshupMessage(d.phone, `#${rideReq2.id} ${rideReq2.from} -> ${rideReq2.to} | ${toDisplayTime(rideReq2.time)}\nReply ${rideReq2.id} or TAKE ${rideReq2.id}`);
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
