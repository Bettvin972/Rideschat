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
function killChatFor(phone) {
    for (let k in activeChats) {
        if (k===phone || activeChats[k]?.with===phone) {
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
    // FIXED: added yes, yeah, yep, etc
    const block = ['hi','hey','hello','sasa','mambo','niaje','need','ride','offer','driver','car','online','offline','filter','clear','next','now','sai','kesho','today','thanks','asante','ok','okay','yes','yeah','yep','yebo','sawa','poa','asante','cool','thx','thanks','need offer','offer ride','need to offer','i need','available','requests','show','all','see','my','trip','accept','take','end ride'];
    if (block.some(b => t===b || t.startsWith(b+' '))) return false;
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

async function checkAndForwardChat(phoneJid, text, realPhone) {
    const userPhoneKey = realPhone || phoneJid;
    let chat = activeChats[userPhoneKey];
    if (!chat) return false;
    try {
        let ride = await RideRequest.findById(chat.rideId);
        if (!ride || ride.status!=='TAKEN') {
            killChatFor(userPhoneKey);
            return false;
        }
        let other = chat.with;
        let sender = ride.phone===userPhoneKey? "Rider" : "Driver";
        let receiver = sender==="Rider"? "driver" : "rider";
        await sendGupshupMessage(other, `${sender} #${chat.rideId}: ${text}`);
        await sendGupshupMessage(phoneJid, `Sent to ${receiver}`);
        return true;
    } catch(e){ return false; }
}

async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        const userPhoneKey = realPhone||phoneJid;

        // 1. END RIDE - ALWAYS FIRST
        if (lowerText.includes('end ride') || ['complete','trip done','cancel ride','done','finished'].includes(lowerText)) {
            killChatFor(userPhoneKey);
            try {
                let r = await RideRequest.findOne({where:{status:'TAKEN', [Op.or]:[{phone:userPhoneKey},{driverPhone:userPhoneKey}]}, order:[['updatedAt','DESC']]});
                if(r){ r.status='COMPLETED'; await r.save(); }
            } catch(e){}
            clearSession(userPhoneKey);
            await sendGupshupMessage(phoneJid, "Trip ended. Chat closed.\nNeed another? Say: Need a ride");
            return;
        }

        // 2. IGNORE short acks that are not in chat
        if (!activeChats[userPhoneKey]) {
            if (lowerText.includes('👍') || lowerText.includes('❤️') || lowerText.includes('😍')) return;
            if (['okay','ok','cool','thx','thanks','asante','yes','yeah'].includes(lowerText) && lowerText.length < 6) return;
        }

        // 3. NEW SESSION commands - kill old chat
        const isNewStart = lowerText==='offline' || lowerText.startsWith('offline') || lowerText==='online' || lowerText.startsWith('online') || lowerText==='need a ride' || lowerText==='need ride' || lowerText.startsWith('need a ride') || lowerText.startsWith('filter ') || lowerText.includes('clear filter');
        if (isNewStart) {
            killChatFor(userPhoneKey);
            if (lowerText.includes('need a ride') || lowerText==='need ride') clearSession(userPhoneKey);
        }

        // 4. FIXED: IF IN ACTIVE CHAT, FORWARD FIRST - BEFORE LOCATION CHECK
        // This fixes your screenshot: Yes -> Sent to rider, not "Okay from Yes where to?"
        if (activeChats[userPhoneKey]) {
            if (await checkAndForwardChat(phoneJid, text, realPhone)) return;
        }

        // 5. LOCATION - only for users NOT in active chat
        if (isSimpleLocation(text)) {
            var user = await User.getOrCreate(userPhoneKey);
            var session = getSession(userPhoneKey);
            if (!session.draft.from) {
                session.draft.from = text.trim(); session.draft.role='rider';
                await sendGupshupMessage(phoneJid, `Okay, from ${session.draft.from} — where to?`);
                return;
            }
            if (session.draft.from &&!session.draft.to) {
                session.draft.to = text.trim();
                await sendGupshupMessage(phoneJid, `Got it, ${session.draft.from} → ${session.draft.to}. What time? Reply Now or 9 AM`);
                return;
            }
        }

        // 6. Single number TAKE
        if (/^\d+$/.test(lowerText)) {
            let rideId = parseInt(lowerText,10);
            let ride = await RideRequest.findById(rideId);
            if (!ride) { await sendGupshupMessage(phoneJid, `Ride #${rideId} not found. Try ONLINE to see rides`); return; }
            if (ride.phone===userPhoneKey) { await sendGupshupMessage(phoneJid, `You can't take your own ride #${rideId}`); return; }
            if (ride.status==='OPEN') {
                ride.status='TAKEN'; ride.driverPhone=userPhoneKey; await ride.save();
                activeChats[ride.phone]={with:userPhoneKey, rideId:ride.id};
                activeChats[userPhoneKey]={with:ride.phone, rideId:ride.id};
                let riderLink = getDirectChatLink(ride.phone);
                let driverLink = getDirectChatLink(userPhoneKey);
                await sendGupshupMessage(phoneJid, `MATCHED #${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\nRider: ${riderLink}\nEND RIDE when done`);
                await sendGupshupMessage(ride.phone, `DRIVER FOUND #${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${driverLink}\nReply here to chat`);
                return;
            } else { await sendGupshupMessage(phoneJid, `Ride #${rideId} already taken`); return; }
        }

        if (lowerText.includes('offer') && lowerText.includes('ride')) {
            let u = await User.getOrCreate(userPhoneKey);
            await u.setOnline("Juja",2);
            let nearby = await RideRequest.getNearby(u.location);
            await sendGupshupMessage(phoneJid, `ONLINE: ${u.location} | ${u.rating.toFixed(1)}`);
            await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES NEAR ${u.location.toUpperCase()}:`);
            clearSession(userPhoneKey); return;
        }
        if (lowerText.includes('see all') || lowerText.includes('available rides') || lowerText.includes('show requests')) {
            let nearby = await RideRequest.getNearby("Juja");
            await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES IN JUJA:`);
            clearSession(userPhoneKey); return;
        }
        if (lowerText.startsWith('filter ')) {
            let filterLoc = text.substring(7).trim();
            let u = await User.getOrCreate(userPhoneKey); u.filterFrom=filterLoc; await u.save();
            let nearby = await RideRequest.getNearby(filterLoc);
            await sendRidesList(phoneJid, nearby, `Filter ${filterLoc} | ${nearby.length} rides`); return;
        }
        if (lowerText==='clear filters' || lowerText==='clear filter') {
            let u = await User.getOrCreate(userPhoneKey); u.filterFrom=null; await u.save();
            let nearby = await RideRequest.getNearby(u.location||'Juja');
            await sendRidesList(phoneJid, nearby, `Filters cleared`); return;
        }

        const takeMatch = lowerText.match(/^take[_\s]*(\d+)$/i);
        if (takeMatch) {
            let rideId = parseInt(takeMatch[1],10);
            let ride = await RideRequest.findById(rideId);
            if (!ride || ride.status!=='OPEN') { await sendGupshupMessage(phoneJid, `Ride #${rideId} not available`); return; }
            if (ride.phone===userPhoneKey) { await sendGupshupMessage(phoneJid, `Can't take own ride`); return; }
            ride.status='TAKEN'; ride.driverPhone=userPhoneKey; await ride.save();
            activeChats[ride.phone]={with:userPhoneKey, rideId:ride.id};
            activeChats[userPhoneKey]={with:ride.phone, rideId:ride.id};
            await sendGupshupMessage(phoneJid, `MATCHED #${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\nRider: ${getDirectChatLink(ride.phone)}`);
            await sendGupshupMessage(ride.phone, `DRIVER FOUND #${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${getDirectChatLink(userPhoneKey)}`);
            return;
        }

        var user2 = await User.getOrCreate(userPhoneKey);
        var session2 = getSession(userPhoneKey);

        if (session2.draft.from && session2.draft.to &&!session2.draft.time) {
            let qt = parseTimeQuick(lowerText);
            if (qt) {
                session2.draft.time = qt; session2.draft.date = getRealDate('today');
                await sendGupshupMessage(phoneJid, `Perfect, ${session2.draft.from} → ${session2.draft.to} at ${toDisplayTime(qt)} — creating...`);
                var rr = await RideRequest.createCustom(userPhoneKey, session2.draft);
                await sendGupshupMessage(phoneJid, `RIDE #${rr.id} CREATED\n${rr.from} → ${rr.to} at ${toDisplayTime(rr.time)} Today\nAlerting drivers...`);
                var drvs = await User.getOnlineNearby(rr.from);
                var clean = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
                var filtered = drvs.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean;});
                for (let d of filtered) await sendGupshupMessage(d.phone, `#${rr.id} ${rr.from} → ${rr.to} | ${toDisplayTime(rr.time)}\nReply ${rr.id} or TAKE ${rr.id}`);
                clearSession(userPhoneKey); return;
            } else {
                await sendGupshupMessage(phoneJid, `What time? Reply Now or 9 AM`);
                return;
            }
        }

        var ai = await parseWithAI(text, session2.draft);
        if (ai.role==='chat') {
            await sendGupshupMessage(phoneJid, `${getTimeGreeting()}! Where are you riding from today?`);
            return;
        }
        if (ai.role==='command') {
            if (ai.command==='ONLINE') {
                await user2.setOnline(ai.from||session2.draft.from||"Juja",2);
                var nearby = await RideRequest.getNearby(user2.location);
                await sendGupshupMessage(phoneJid, `ONLINE: ${user2.location} | ${user2.rating.toFixed(1)}`);
                await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES NEAR ${user2.location.toUpperCase()}:`);
            }
            if (ai.command==='OFFLINE') { await user2.setOffline(); clearSession(userPhoneKey); await sendGupshupMessage(phoneJid, `OFFLINE - ${getTimeGreeting()}!`); }
            if (ai.command==='SHOW_REQUESTS') {
                var nearby2 = await RideRequest.getNearby("Juja");
                await sendRidesList(phoneJid, nearby2, `${nearby2.length} RIDES IN JUJA:`);
            }
            return;
        }
        if (session2.draft.role==='rider' && (!session2.draft.from||!session2.draft.to)) {
            if (!session2.draft.from) await sendGupshupMessage(phoneJid, `WHERE FROM? Eg: Juja`);
            else await sendGupshupMessage(phoneJid, `Okay, from ${session2.draft.from} — where to?`);
            return;
        }
        if (session2.draft.role==='rider' &&!session2.draft.time) { await sendGupshupMessage(phoneJid, `What time? Now or 9 AM?`); return; }
        if (session2.draft.role==='rider') {
            var rideReq2 = await RideRequest.createCustom(userPhoneKey, session2.draft);
            await sendGupshupMessage(phoneJid, `RIDE #${rideReq2.id} CREATED\n${rideReq2.from} → ${rideReq2.to} ${toDisplayTime(rideReq2.time)}`);
            var drivers2 = await User.getOnlineNearby(rideReq2.from);
            var clean2 = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
            var f2 = drivers2.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean2;});
            for (let d of f2) await sendGupshupMessage(d.phone, `#${rideReq2.id} ${rideReq2.from} → ${rideReq2.to} | ${toDisplayTime(rideReq2.time)}\nReply ${rideReq2.id}`);
            clearSession(userPhoneKey); return;
        }
    } catch(err){ console.error('Error:',err.stack||err.message); }
}

setInterval(async()=>{ try{ if (RideRequest.clearExpired) await RideRequest.clearExpired(); }catch(e){} },15*60*1000);

app.get('/qr',(req,res)=>{ if (!qrLast) return res.send("<h1>Connected!</h1>"); var qrImage="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data="+encodeURIComponent(qrLast); res.send(`<h1>Scan</h1><img src='${qrImage}'/>`); });
app.get('/ping',(req,res)=>{ res.send("Alive"); });
app.get('/',(req,res)=>{ res.send("Rideschat LIVE - /qr"); });
app.get('/clearall', async (req,res)=>{
    await RideRequest.destroy({ where: {} });
    await RideOffer.destroy({ where: {} });
    for (let k in activeChats) delete activeChats[k];
    for (let k in userSessions) delete userSessions[k];
    res.send("All rides deleted + memory cleared");
});
app.get('/cleardb', async (req,res)=>{ await sequelize.sync({ force: true }); res.send("Full DB wiped"); });

var PORT = process.env.PORT||10000;
app.listen(PORT,()=>{ console.log("Running on "+PORT); });
