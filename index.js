require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { sequelize, User, RideRequest, RideOffer } = require('./database');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

sequelize.sync({ alter: true }).then(() => { console.log("DB Synced"); }).catch(e => { console.error("DB Sync error:", e.message); });

let sock = null;
let qrLast = null;
const AUTH_PATH = path.join(__dirname, 'auth_info');

const userSessions = {};
function getSession(phone) {
    if (!userSessions[phone]) userSessions[phone] = { draft: {}, lastUpdated: Date.now() };
    return userSessions[phone];
}
function clearSession(phone) { delete userSessions[phone]; }

function getNairobiNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
}
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
    const str = aiDate.toString().toLowerCase();
    if (['today','now','null','asap','immediately','leo','sai','sahii','saa hii','now now'].includes(str)) return now.toISOString().split('T')[0];
    if (['tomorrow','kesho'].includes(str)) { var t = new Date(now); t.setDate(now.getDate()+1); return t.toISOString().split('T')[0]; }
    return aiDate;
}
function getRealTime(aiTime) {
    const now = getNairobiNow();
    const hhNow = String(now.getHours()).padStart(2,'0');
    const mmNow = String(now.getMinutes()).padStart(2,'0');
    if (!aiTime) return `${hhNow}:${mmNow}`;
    let lower = aiTime.toString().toLowerCase().trim();
    if (['now','asap','sasa','sai','sahii','saa hii','sasa hivi','now now','right now'].includes(lower)) return `${hhNow}:${mmNow}`;
    let m = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (m) {
        let h = parseInt(m[1]); let min = parseInt(m[2]||'0'); let ap = m[3];
        if (ap==='pm' && h<12) h+=12; if (ap==='am' && h===12) h=0;
        return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    }
    return `${hhNow}:${mmNow}`;
}
function toDisplayTime(time24) {
    if (!time24 || time24==='Flexible') return 'now';
    let [h,m] = time24.split(':').map(Number);
    if (isNaN(h)) return time24;
    let ampm = h>=12?'PM':'AM';
    let hh = h%12||12;
    return `${hh}:${String(m||0).padStart(2,'0')} ${ampm}`;
}
function cleanContactNumber(jid) {
    if (!jid) return "Contact via Bot";
    let num = jid.split('@')[0].replace(/[^0-9]/g,'');
    if (num.length<9) return "Reply here";
    if (num.startsWith('0')) num='254'+num.slice(1);
    if (!num.startsWith('254') && num.length===9) num='254'+num;
    return `https://wa.me/${num}`;
}
function parseTimeQuick(input) {
    if (!input) return null;
    let t = input.toLowerCase().trim();
    const now = getNairobiNow();
    if (['now','sai','sahii','saa hii','sasa','sasa hivi','now now','asap'].includes(t)) {
        return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    }
    if (t==='kesho' || t==='tomorrow') return '09:00';
    let m = t.match(/^(\d{1,2})(\s*(am|pm))?$/);
    if (m) { let h=parseInt(m[1]); let ap=m[3]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:00`; }
    let m2 = t.match(/(\d{1,2}):(\d{2})(\s*(am|pm))?/);
    if (m2) { let h=parseInt(m2[1]); let min=parseInt(m2[2]); let ap=m2[4]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`; }
    return null;
}
function isSimpleLocation(txt) {
    const t = txt.toLowerCase().trim();
    const bad = ['hi','hey','sasa','mambo','need','ride','online','offline','filter','clear','next','now','sai','kesho','today','thanks','asante','ok','okay','hello'];
    if (bad.includes(t)) return false;
    if (t.includes('need a ride')) return false;
    if (t.length < 3 || t.length > 30) return false;
    if (/^\d+$/.test(t)) return false;
    if (parseTimeQuick(t)) return false;
    return /^[a-zA-Z\s,]+$/.test(t);
}

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version, auth: state, logger: pino({ level: 'silent' }),
        printQRInTerminal: false, browser: ["Rideschat","Chrome","1.0.0"],
        shouldSyncHistoryMessage: () => false, syncFullHistory: false, markOnlineOnConnect: false,
        getMessage: async () => undefined
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { qrLast = qr; console.log("QR READY"); }
        if (connection==='open') { console.log('Connected!'); qrLast=null; }
        if (connection==='close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            qrLast=null; sock=null;
            if (statusCode===DisconnectReason.loggedOut || statusCode===401) {
                if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH,{recursive:true,force:true});
            }
            setTimeout(startWhatsApp,5000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages ||!messages[0]) return;
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
        } catch (e) {
            if (e.message && e.message.includes('Bad MAC')) return;
            console.error('upsert error:', e.message);
        }
    });
}
startWhatsApp();

var SYSTEM_PROMPT = `You are Rideschat Kenya. Current: {TODAY_INFO} [{TODAY_DATE}] {GREETING}. Draft: {CONTEXT_DRAFT}
Classify:
1. CHITCHAT: Hi,Hey,Mambo,Weather,Fare,How are you,Thanks -> {"role":"chat","reply":null}
2. RIDE: Extract from/to/date/time. Single word location is valid.
3. COMMAND: TAKE 1,TAKE_1,ONLINE,OFFLINE,FILTER Juja,CLEAR FILTERS,NEXT
Return ONLY JSON:
{"role":"rider|driver|command|chat","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|FILTER|CLEAR_FILTERS|NEXT|null","filter":string|null,"takeId":number|null,"from":string|null,"to":string|null,"date":"YYYY-MM-DD|today|tomorrow|null","time":"HH:MM|now|null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":true,"rating":null}
`;

async function parseWithAI(msg, contextDraft={}) {
    var now = getNairobiNow();
    var tomorrow = new Date(now); tomorrow.setDate(now.getDate()+1);
    var todayInfo = now.toLocaleDateString('en-US',{weekday:'long'})+" "+now.toISOString().split('T')[0];
    var greeting = getTimeGreeting();
    var systemPrompt = SYSTEM_PROMPT.replaceAll("{TODAY_INFO}",todayInfo).replaceAll("{TODAY_DATE}",now.toISOString().split('T')[0]).replaceAll("{GREETING}",greeting).replaceAll("{CONTEXT_DRAFT}",JSON.stringify(contextDraft));
    var apiKey = process.env.GROQ_API_KEY;
    var models = ["openai/gpt-oss-20b","openai/gpt-oss-120b","llama-3.3-70b-versatile"];
    for (var i=0;i<models.length;i++) {
        try {
            var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
                { model: models[i], messages: [{role:"system",content:systemPrompt},{role:"user",content:`Message: "${msg}"`}], temperature:0.2, response_format:{type:"json_object"} },
                { headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json"} }
            );
            var data = JSON.parse(res.data.choices[0].message.content.trim());
            if (data.date) data.date=getRealDate(data.date);
            if (data.time) data.time=getRealTime(data.time);
            return data;
        } catch(err) {
            if (i===models.length-1) throw err;
        }
    }
}

async function answerGeneralQuestion(question, userLocation="Juja") {
    try {
        const now = getNairobiNow();
        const timeStr = now.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday:'long', hour:'2-digit', minute:'2-digit' });
        const greeting = getTimeGreeting();
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b",
            messages: [
                { role: "system", content: `You are Rideschat Kenya, friendly. Current: ${timeStr} EAT (${greeting}), location: ${userLocation}.
- Greeting: reply "${greeting}! Karibu Rideschat." + "Say: Niko Juja nataka kuenda Thika sai"
- Weather: Say typical weather in ${userLocation}, advise check Google for live. 2 lines max.
- Other: answer short 2 lines, then ask location for ride.
- No emojis overload, max 1 emoji.
- Never say "I'm not sure".` },
                { role: "user", content: question }
            ],
            temperature: 0.7
        }, { headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch (e) { return null; }
}

async function sendGupshupMessage(toJid, messageText) {
    if (!toJid||!sock) return;
    try {
        let jid = toJid.includes('@')?toJid:toJid.replace('+','').trim()+'@s.whatsapp.net';
        await sock.sendMessage(jid,{text:messageText});
    } catch(err){console.error('Send error:',err.message);}
}

async function sendRideButton(toJid, ride) {
    if (!toJid||!sock) return;
    try {
        let jid = toJid.includes('@')? toJid : toJid.replace('+','').trim() + '@s.whatsapp.net';
        let from = ride.from.split(',')[0].substring(0,18).trim();
        let to = ride.to.split(',')[0].substring(0,18).trim();
        let when = toDisplayTime(ride.time);
        let ppl = ride.people || ride.seats || 1;
        let text = `#${ride.id} ${from} -> ${to} | ${ppl}p | ${when}`;

        await sock.sendMessage(jid, {
            text: text,
            footer: "Rideschat - Tap to accept",
            templateButtons: [
                { index: 1, quickReplyButton: { displayText: `TAKE #${ride.id}`, id: `TAKE_${ride.id}` } },
                { index: 2, quickReplyButton: { displayText: `VIEW #${ride.id}`, id: `VIEW_${ride.id}` } }
            ]
        });
    } catch(e){
        console.error('Button fail:', e.message);
        await sendGupshupMessage(toJid, `#${ride.id} ${ride.from} -> ${ride.to} | ${toDisplayTime(ride.time)}\nReply TAKE ${ride.id}`);
    }
}

async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        const userPhoneKey = realPhone||phoneJid;
        if (['okay','ok','cool','thx','thanks'].includes(lowerText)) return;
        if (lowerText.includes('need a ride') || lowerText === 'need ride') clearSession(userPhoneKey);

        if (lowerText.startsWith('filter ')) {
            let filterLoc = text.substring(7).trim();
            let u = await User.getOrCreate(userPhoneKey);
            u.filterFrom=filterLoc; await u.save();
            let nearby = await RideRequest.getNearby(filterLoc);
            if (nearby.length===0) await sendGupshupMessage(phoneJid,`Filter: ${filterLoc}\nNo rides now.`);
            else {
                await sendGupshupMessage(phoneJid,`Filter: ${filterLoc} | ${nearby.length} rides - Tap TAKE:`);
                for (let r of nearby.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
            }
            return;
        }
        if (lowerText==='clear filters'||lowerText==='clear filter') {
            let u = await User.getOrCreate(userPhoneKey); u.filterFrom=null; await u.save();
            let nearby = await RideRequest.getNearby(u.location||'Juja');
            await sendGupshupMessage(phoneJid,`Filters cleared - ${nearby.length} rides`);
            for (let r of nearby.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
            return;
        }

        const takeMatch = lowerText.match(/^take[_\s]*(\d+)$/i);
        const viewMatch = lowerText.match(/^view[_\s]*(\d+)$/i);
        var user = await User.getOrCreate(userPhoneKey);
        var session = getSession(userPhoneKey);

        if (viewMatch) {
            let id = parseInt(viewMatch[1],10);
            let ride = await RideRequest.findById(id);
            if (ride) await sendGupshupMessage(phoneJid, `Trip #${ride.id}\n${ride.from} -> ${ride.to}\nWhen: ${toDisplayTime(ride.time)} Today\nContact: ${cleanContactNumber(ride.phone)}\nReply TAKE ${ride.id} to accept`);
            return;
        }

        if (!session.draft.from && isSimpleLocation(text)) {
            session.draft.from = text.trim();
            session.draft.role = 'rider';
            await sendGupshupMessage(phoneJid,`FROM: ${session.draft.from} saved\n\nWHERE TO?\nEg: Thika`);
            return;
        }
        if (session.draft.from &&!session.draft.to && isSimpleLocation(text)) {
            session.draft.to = text.trim();
            await sendGupshupMessage(phoneJid,`TO: ${session.draft.to} saved\n\nWHAT TIME?\nReply: Now / Sai / 9 / 3 PM`);
            return;
        }
        if (session.draft.from && session.draft.to &&!session.draft.time) {
            let quickTime = parseTimeQuick(lowerText);
            if (quickTime) {
                session.draft.time = quickTime;
                session.draft.date = getRealDate('today');
                var rideReq = await RideRequest.createCustom(userPhoneKey, session.draft);
                await sendGupshupMessage(phoneJid,`RIDE #${rideReq.id} CREATED\n${rideReq.from} -> ${rideReq.to}\n${toDisplayTime(rideReq.time)} Today\nAlerting drivers...`);
                var drivers = await User.getOnlineNearby(rideReq.from);
                var currentClean = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
                var filtered = drivers.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==currentClean;});
                for (let d of filtered) { await sendRideButton(d.phone, rideReq); }
                clearSession(userPhoneKey); return;
            }
        }

        var ai = await parseWithAI(text, session.draft);

        if (ai.role==='chat') {
            const userLoc = user.location || session.draft.from || "Juja";
            let reply = await answerGeneralQuestion(text, userLoc);
            if (!reply) reply = `${getTimeGreeting()}! Karibu Rideschat.\nSay: Niko Juja nataka kuenda Thika sai`;
            await sendGupshupMessage(phoneJid, reply);
            return;
        }

        let newFrom = ai.from||null; let newTo = ai.to||null;
        if (session.draft.from &&!session.draft.to && newFrom &&!newTo) { newTo=newFrom; newFrom=session.draft.from; }

        session.draft = {
            role: ai.role||session.draft.role||'rider',
            from: newFrom||session.draft.from||null,
            to: newTo||session.draft.to||null,
            date: ai.date||session.draft.date||null,
            time: ai.time||session.draft.time||null,
            bags: ai.bags??session.draft.bags??0,
            girls_only: false
        };

        if (takeMatch) { ai.role='command'; ai.command='TAKE'; ai.takeId=parseInt(takeMatch[1],10); }

        if (ai.role==='command') {
            if (ai.command==='ONLINE') {
                await user.setOnline(ai.from||session.draft.from||"Juja",2);
                var nearby = await RideRequest.getNearby(user.location);
                if (nearby.length===0) {
                    await sendGupshupMessage(phoneJid,`ONLINE: ${user.location} | ${user.rating.toFixed(1)}\nNo rides now. Stay ONLINE.\n${getTimeGreeting()}!`);
                } else {
                    await sendGupshupMessage(phoneJid,`ONLINE: ${user.location} | ${user.rating.toFixed(1)}\n${nearby.length} RIDES - Tap TAKE:`);
                    for (let r of nearby.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
                    if (nearby.length>5) await sendGupshupMessage(phoneJid,`+ ${nearby.length-5} more. Type NEXT`);
                }
            }
            if (ai.command==='OFFLINE') { await user.setOffline(); clearSession(userPhoneKey); await sendGupshupMessage(phoneJid,`OFFLINE - ${getTimeGreeting()}!`); }
            if (ai.command==='SHOW_REQUESTS') {
                var nearby2 = await RideRequest.getNearby("Juja");
                if (nearby2.length===0) await sendGupshupMessage(phoneJid,`No rides in Juja`);
                else {
                    await sendGupshupMessage(phoneJid,`${nearby2.length} RIDES IN JUJA:`);
                    for (let r of nearby2.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
                }
            }
            if (ai.command==='TAKE') {
                var ride = await RideRequest.findById(ai.takeId);
                if (ride && ride.status==='PENDING') {
                    await ride.updateStatus("TAKEN");
                    await sendGupshupMessage(phoneJid,`MATCHED #${ride.id}!\n${ride.from} -> ${ride.to}\n${toDisplayTime(ride.time)}\nRider: ${cleanContactNumber(ride.phone)}\nCall now!`);
                    await sendGupshupMessage(ride.phone,`DRIVER FOUND!\nTrip ${ride.from} -> ${ride.to}\nDriver: ${cleanContactNumber(userPhoneKey)}\nDriver will call you`);
                } else {
                    await sendGupshupMessage(phoneJid,`Ride #${ai.takeId} already taken.`);
                }
            }
            return;
        }

        if (session.draft.role==='rider' && (!session.draft.from||!session.draft.to)) {
            if (!session.draft.from) await sendGupshupMessage(phoneJid,`WHERE FROM?\nEg: Juja`);
            else await sendGupshupMessage(phoneJid,`WHERE TO?\nYou are in ${session.draft.from}, where to? Eg: Thika`);
            return;
        }
        if (session.draft.role==='rider' &&!session.draft.time) {
            await sendGupshupMessage(phoneJid,`WHAT TIME?\nReply: Now / Sai / 9 / 3 PM`);
            return;
        }
        if (session.draft.role==='rider') {
            var rideReq2 = await RideRequest.createCustom(userPhoneKey, session.draft);
            await sendGupshupMessage(phoneJid,`RIDE #${rideReq2.id} CREATED\n${rideReq2.from} -> ${rideReq2.to}\n${toDisplayTime(rideReq2.time)} Today\nAlerting drivers...`);
            var drivers2 = await User.getOnlineNearby(rideReq2.from);
            var currentClean2 = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
            var filtered2 = drivers2.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==currentClean2;});
            for (let d of filtered2) { await sendRideButton(d.phone, rideReq2); }
            clearSession(userPhoneKey); return;
        }
    } catch(err){ console.error('Error:',err.stack||err.message); }
}

setInterval(async()=>{ try{ if (RideRequest.clearExpired) await RideRequest.clearExpired(); if (RideOffer.clearExpired) await RideOffer.clearExpired(); }catch(e){} },15*60*1000);

app.get('/qr',(req,res)=>{ if (!qrLast) return res.send("<h1>Connected! Bot Live</h1>"); var qrImage="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data="+encodeURIComponent(qrLast); res.send("<h1>Scan Safaricom line</h1><p>WhatsApp > Linked Devices > Link</p><img src='"+qrImage+"'/>"); });
app.get('/ping',(req,res)=>{ res.send("Rideschat Kenya Alive"); });
app.get('/',(req,res)=>{ res.send("Rideschat Kenya LIVE - Go to /qr"); });
app.get('/clearbad', async (req,res)=>{ await RideRequest.destroy({ where: { status: 'PENDING' } }); res.send("Cleared old rides"); });
var PORT = process.env.PORT||10000;
app.listen(PORT,()=>{ console.log("Rideschat Kenya running on port "+PORT); });
