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
    const keys = Object.keys(activeChats);
    for (let k of keys) {
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
    if (s.includes('next week')) {
        let t = new Date(now); t.setDate(now.getDate()+7); return t.toISOString().split('T')[0];
    }
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
function toDisplayTime(t) {
    if (!t || t==='Flexible') return 'now';
    let [h,m] = t.split(':').map(Number);
    if (isNaN(h)) return t;
    let ap = h>=12?'PM':'AM'; let hh = h%12||12;
    return `${hh}:${String(m||0).padStart(2,'0')} ${ap}`;
}
function toDisplayDate(d) {
    if (!d) return '';
    const ld = d.toLowerCase();
    if (ld.includes('next week')) return 'Next week';
    if (ld.includes('invalid')) return 'Next week';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const now = getNairobiNow();
    const today = now.toISOString().split('T')[0];
    let tom = new Date(now); tom.setDate(now.getDate()+1);
    const tomorrow = tom.toISOString().split('T')[0];
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    let date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return date.toLocaleDateString('en-US',{weekday:'long'}) + ' ' + d;
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
    let m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
    if (m) { let h=parseInt(m[1]); let min=parseInt(m[2]||'0'); let ap=m[3]; if(ap==='pm'&&h<12)h+=12; if(ap==='am'&&h===12)h=0; return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`; }
    let m2 = t.match(/(\d{1,2}):(\d{2})/);
    if (m2) return `${String(parseInt(m2[1])).padStart(2,'0')}:${String(parseInt(m2[2])).padStart(2,'0')}`;
    if (['now','asap'].includes(t)) return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    if (t==='tomorrow') return '09:00';
    const weekdays = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    if (weekdays.some(d=>t.includes(d)) &&!t.match(/\d/)) return '09:00';
    return null;
}
function parseRating(txt) {
    const t = txt.toLowerCase().trim();
    if (t.includes('⭐')) {
        const count = (t.match(/⭐/g) || []).length;
        if (count>=1 && count<=5) return count;
    }
    if (/^[1-5]$/.test(t)) return parseInt(t);
    let m = t.match(/\b([1-5])\b/);
    if (m) return parseInt(m[1]);
    return null;
}
async function addRatingToUser(phone, newRating) {
    try {
        let u = await User.getOrCreate(phone);
        if (u.rating === null || u.rating === undefined) u.rating = 5;
        if (u.ratingCount === null || u.ratingCount === undefined) u.ratingCount = 0;
        let total = u.rating * u.ratingCount + newRating;
        u.ratingCount += 1;
        u.rating = total / u.ratingCount;
        await u.save();
        return u.rating;
    } catch(e){
        console.error("Rating save error:", e.message);
        return 5;
    }
}
function isSimpleLocation(txt) {
    const t = txt.toLowerCase().trim();
    const exactBlock = ['hi','hey','hello','need','ride','offer','driver','car','online','offline','filter','clear','next','now','today','tomorrow','thanks','thank','thank you','ok','okay','yes','yeah','yep','cool','thx','available','requests','show','all','see','my','trip','accept','take','end ride','who are you','what are you','help','what can you do','how does it work','what is','who is','where is','how can','how to','rate','rating','need a ride','need ride','i need a ride'];
    if (exactBlock.includes(t)) return false;
    if (t.includes('how can i') || t.includes('need a ride to') || t.length > 35) return false;
    if (t.length < 3 || t.length > 35) return false;
    if (/^\d+$/.test(t)) return false;
    if (!/^[a-zA-Z\s]+$/.test(t)) return false;
    if (t.split(' ').length > 4) return false;
    return true;
}
async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ["Bett","Chrome","1.0"], shouldSyncHistoryMessage: () => false, syncFullHistory: false, markOnlineOnConnect: false, getMessage: async () => undefined });
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
var SYSTEM_PROMPT = `You are Bett, a student ride-sharing assistant in Kenya. Current: {TODAY_INFO} [{TODAY_DATE}] {GREETING}. Draft: {CONTEXT_DRAFT}
Classify:
1. CHITCHAT: Hi, Who are you, What can you do, Help, How does it work -> {"role":"chat"}
2. RIDE: Extract from/to/date/time - "from Juja to Thika now", "Juja to Thika at 9am tomorrow", "Friday to Thika", "Isiolo to Kangemi tomorrow at 6 pm", "Need ride Monday 8am" -> {"role":"rider", from, to, date, time}
   date can be: today, tomorrow, monday, tuesday, wednesday, thursday, friday, saturday, sunday
3. COMMAND: TAKE 1, ONLINE, OFFLINE, FILTER Juja, CLEAR FILTERS -> {"role":"command"}
Return ONLY JSON:
{"role":"rider|driver|command|chat","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|FILTER|CLEAR_FILTERS|NEXT|null","filter":string|null,"takeId":number|null,"from":string|null,"to":string|null,"date":"today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|null","time":"HH:MM|now|null","seats":number|null}
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
    const lower = q.toLowerCase().trim();
    if (!lower || lower.length <= 2) return null;
    if (/^\d+$/.test(lower)) return null;
    if (['thanks','thank you','thankyou','asante','asante sana','thx'].includes(lower)) return "You're welcome!";
    if (lower.startsWith('okay') || ['ok','okay','sawa','poa','cool','nice','great','alright'].includes(lower)) return "Got it!";
    if (['hi','hey','hello','niaje','mambo','hii','heyy','yo'].includes(lower)) return `${getTimeGreeting()}! I'm Bett - I help students with rides.`;
    if (lower.includes('who are you') || lower.includes('what are you')) return "I'm Bett! I help students in Kenya connect with affordable rides.";
    if (lower.includes('is there any driver') || lower.includes('any drivers') || lower.includes('are there drivers')) {
        return "Yes, we have drivers online! If you need a ride, just say Need a ride and tell me where from and where to. If you're a driver, say ONLINE to see ride requests.";
    }
    if (lower.includes('help') || lower.includes('what can you do') || lower.includes('how does it work')) {
        return "I'm Bett! I connect students who need rides with drivers. Riders: Say 'Need a ride' and tell me your route and time. Drivers: Say 'Online' to see nearby requests and reply with the ride number to accept.";
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
async function sendGupshupMessage(toJid, txt) {
    if (!toJid||!sock) return;
    try { let jid = toJid.includes('@')?toJid:toJid.replace('+','').trim()+'@s.whatsapp.net'; await sock.sendMessage(jid,{text:txt}); } catch(e){console.error(e.message);}
}
async function sendRidesList(toJid, rides, title="RIDES:") {
    if (!rides || rides.length===0) { await sendGupshupMessage(toJid, `${title}\nNo rides now. Stay ONLINE or FILTER`); return; }
    let firstId = rides[0].id;
    let lines = [];
    for (let r of rides.slice(0,10)) {
        try {
            let u = await User.getOrCreate(r.phone);
            let rate = `${(u.rating||5).toFixed(1)}⭐`;
            lines.push(`#${r.id} ${r.from?.split(',')[0].substring(0,15)} -> ${r.to?.split(',')[0].substring(0,15)} | ${r.seats||1}p | ${toDisplayTime(r.time)} ${r.date? toDisplayDate(r.date):''} | Rider ${rate}`);
        } catch(e) {
            lines.push(`#${r.id} ${r.from?.split(',')[0].substring(0,15)} -> ${r.to?.split(',')[0].substring(0,15)} | ${r.seats||1}p | ${toDisplayTime(r.time)}`);
        }
    }
    await sendGupshupMessage(toJid, `${title}\n${lines.join('\n')}\n\nReply ${firstId} or TAKE ${firstId} to accept`);
}
async function checkAndForwardChat(phoneJid, text, realPhone) {
    const userPhoneKey = realPhone || phoneJid;
    let chat = activeChats[userPhoneKey];
    if (!chat) return false;
    try {
        let ride = await RideRequest.findById(chat.rideId);
        if (!ride || ride.status!=='TAKEN') { killChatFor(userPhoneKey); return false; }
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
        if (lowerText.length < 2) return;
        const userPhoneKey = realPhone||phoneJid;

        // 1. RATING FIRST
        let ratingSession = getSession(userPhoneKey);
        if (ratingSession && ratingSession.awaitingRating) {
            let rate = parseRating(lowerText);
            if (rate) {
                let other = ratingSession.awaitingRating.other;
                let rideId = ratingSession.awaitingRating.rideId;
                let newAvg = await addRatingToUser(other, rate);
                clearSession(userPhoneKey);
                await sendGupshupMessage(phoneJid, `✅ Rating saved! You rated ${rate} ⭐ for trip #${rideId}.\nNew rating for other user: ${newAvg.toFixed(1)}⭐\n\nNeed another? Say: Need a ride`);
                try { await sendGupshupMessage(other, `You received a ${rate} ⭐ rating for trip #${rideId}! Your new average: ${newAvg.toFixed(1)}⭐`); } catch(e){}
                return;
            } else if (lowerText.includes('skip') || lowerText==='no') {
                clearSession(userPhoneKey);
                await sendGupshupMessage(phoneJid, "Skipped rating. Need another? Say: Need a ride");
                return;
            } else {
                await sendGupshupMessage(phoneJid, `Please rate 1-5 stars for trip #${ratingSession.awaitingRating.rideId}. Example: 5 or skip`);
                return;
            }
        }

        // 2. HI FIX
        const greetings = ['hi','hey','hello','niaje','mambo','yo','hii','heyy','hi there','hey there','hello there'];
        if (greetings.includes(lowerText)) {
            await sendGupshupMessage(phoneJid, `${getTimeGreeting()}! I'm Bett - I help students with rides.`);
            return;
        }

        // 3. END RIDE FIX - catches "end this ride"
        if (/(end|close|finish|complete).*(ride|trip)/i.test(lowerText) || ['done','finished','complete','trip done','end ride','end trip'].includes(lowerText)) {
            let rideToRate = null;
            try {
                rideToRate = await RideRequest.findOne({where:{status:'TAKEN', [Op.or]:[{phone:userPhoneKey},{driverPhone:userPhoneKey}]}, order:[['updatedAt','DESC']]});
                if(rideToRate){ rideToRate.status='COMPLETED'; await rideToRate.save(); }
            } catch(e){}
            let otherPhone = null;
            if (activeChats[userPhoneKey]) otherPhone = activeChats[userPhoneKey].with;
            else if (rideToRate) {
                otherPhone = rideToRate.phone === userPhoneKey? rideToRate.driverPhone : rideToRate.phone;
            }
            killChatFor(userPhoneKey);
            clearSession(userPhoneKey);
            if (rideToRate && otherPhone) {
                let sessionRater = getSession(userPhoneKey);
                sessionRater.awaitingRating = { rideId: rideToRate.id, other: otherPhone };
                let sessionOther = getSession(otherPhone);
                sessionOther.awaitingRating = { rideId: rideToRate.id, other: userPhoneKey };
                await sendGupshupMessage(phoneJid, `Trip #${rideToRate.id} ended. Thanks for riding with Bett!\n\nPlease rate your experience: Reply with 1-5 stars (5 = Excellent)\nExample: 5`);
                await sendGupshupMessage(otherPhone, `Trip #${rideToRate.id} ended. Thanks for riding with Bett!\n\nPlease rate your experience: Reply with 1-5 stars (5 = Excellent)\nExample: 5`);
            } else {
                await sendGupshupMessage(phoneJid, "Trip ended. Chat closed.\nNeed another? Say: Need a ride");
            }
            return;
        }

        if (!activeChats[userPhoneKey]) {
            if (lowerText.includes('👍') || lowerText.includes('❤️') || lowerText.includes('😍')) { if (lowerText.length < 5) return; }
        }
        if (lowerText==='need a ride' || lowerText==='need ride' || lowerText.startsWith('need a ride') || lowerText==='i need a ride' || lowerText.includes('i need a ride to')) {
            let toMatch = lowerText.match(/to\s+([a-z]+)/);
            let fromMatch = lowerText.match(/from\s+([a-z]+)/);
            let session = getSession(userPhoneKey);
            killChatFor(userPhoneKey);
            if (!fromMatch &&!toMatch) {
                clearSession(userPhoneKey);
                getSession(userPhoneKey).draft.role='rider';
                await sendGupshupMessage(phoneJid, `Got it! Where are you riding from? Example: Juja`);
                return;
            }
            if (fromMatch && toMatch) {
                session.draft = { role:'rider', from: fromMatch[1].charAt(0).toUpperCase()+fromMatch[1].slice(1), to: toMatch[1].charAt(0).toUpperCase()+toMatch[1].slice(1) };
                await sendGupshupMessage(phoneJid, `Got it, ${session.draft.from} → ${session.draft.to}. What time? Reply Now or 9 AM`);
                return;
            }
            if (toMatch &&!session.draft.from) {
                session.draft.role='rider';
                session.draft.to = toMatch[1].charAt(0).toUpperCase()+toMatch[1].slice(1);
                await sendGupshupMessage(phoneJid, `Got it, you need a ride to ${session.draft.to}. Where are you riding from?`);
                return;
            }
            clearSession(userPhoneKey);
            getSession(userPhoneKey).draft.role='rider';
            await sendGupshupMessage(phoneJid, `Got it! Where are you riding from? Example: Juja`);
            return;
        }
        const isNewStart = lowerText==='offline' || lowerText.startsWith('offline') || lowerText==='online' || lowerText.startsWith('online') || lowerText.startsWith('filter ') || lowerText.includes('clear filter');
        if (isNewStart) { killChatFor(userPhoneKey); clearSession(userPhoneKey); }
        if (activeChats[userPhoneKey]) { if (await checkAndForwardChat(phoneJid, text, realPhone)) return; }
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
                await sendGupshupMessage(phoneJid, `Got it, ${session.draft.from} → ${session.draft.to}. What time? Reply Now or Tomorrow 6 PM or Friday 9 AM`);
                return;
            }
        }
        if (/^\d+$/.test(lowerText)) {
            let rideId = parseInt(lowerText,10);
            let ride = await RideRequest.findById(rideId);
            if (!ride) { await sendGupshupMessage(phoneJid, `Ride #${rideId} not found. Try ONLINE to see rides`); return; }
            if (ride.phone===userPhoneKey) { await sendGupshupMessage(phoneJid, `You can't take your own ride #${rideId}`); return; }
            if (ride.status==='OPEN') {
                ride.status='TAKEN'; ride.driverPhone=userPhoneKey; await ride.save();
                activeChats[ride.phone]={with:userPhoneKey, rideId:ride.id};
                activeChats[userPhoneKey]={with:ride.phone, rideId:ride.id};
                let rider = await User.getOrCreate(ride.phone);
                let driver = await User.getOrCreate(userPhoneKey);
                let riderRate = `${(rider.rating||5).toFixed(1)}⭐ (${rider.ratingCount||0})`;
                let driverRate = `${(driver.rating||5).toFixed(1)}⭐ (${driver.ratingCount||0})`;
                let riderLink = getDirectChatLink(ride.phone);
                let driverLink = getDirectChatLink(userPhoneKey);
                await sendGupshupMessage(phoneJid, `MATCHED #${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\nRider: ${riderLink} | Rating: ${riderRate}\nYour Rating: ${driverRate}\nEND RIDE when done`);
                await sendGupshupMessage(ride.phone, `DRIVER FOUND #${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${driverLink} | Rating: ${driverRate}\nYour Rating: ${riderRate}\nReply here to chat`);
                return;
            } else { await sendGupshupMessage(phoneJid, `Ride #${rideId} already taken`); return; }
        }
        if (lowerText.includes('offer') && lowerText.includes('ride')) {
            let u = await User.getOrCreate(userPhoneKey);
            await u.setOnline("Juja",2);
            let nearby = await RideRequest.getNearby(u.location);
            await sendGupshupMessage(phoneJid, `ONLINE: ${u.location} | ${(u.rating||5).toFixed(1)}⭐`);
            await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES NEAR ${u.location.toUpperCase()}:`);
            clearSession(userPhoneKey); return;
        }
        if (lowerText.includes('see all') || lowerText.includes('available rides') || lowerText.includes('show requests')) {
            let nearby = await RideRequest.getNearby("Juja");
            await sendRidesList(phoneJid, nearby, `${nearby.length} RIDES IN JUJA:`);
            clearSession(userPhoneKey); return;
        }
        if (lowerText.includes('my rating') || lowerText==='rating' || lowerText==='my ratings' || lowerText==='ratings' || lowerText==='my rate') {
            let u = await User.getOrCreate(userPhoneKey);
            let avg = (u.rating || 5).toFixed(1);
            let count = u.ratingCount || 0;
            let stars = '⭐'.repeat(Math.round(u.rating || 5));
            await sendGupshupMessage(phoneJid, `Your Rating: ${stars} ${avg}/5\nBased on ${count} trip${count===1?'':'s'}\nKeep giving great rides to stay high!`);
            return;
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
            let rider2 = await User.getOrCreate(ride.phone);
            let driver2 = await User.getOrCreate(userPhoneKey);
            await sendGupshupMessage(phoneJid, `MATCHED #${ride.id} ${ride.from} -> ${ride.to} ${toDisplayTime(ride.time)}\nRider: ${getDirectChatLink(ride.phone)} | ${ (rider2.rating||5).toFixed(1)}⭐\nYour Rating: ${(driver2.rating||5).toFixed(1)}⭐`);
            await sendGupshupMessage(ride.phone, `DRIVER FOUND #${ride.id} ${ride.from} -> ${ride.to}\nDriver: ${getDirectChatLink(userPhoneKey)} | ${(driver2.rating||5).toFixed(1)}⭐\nYour Rating: ${(rider2.rating||5).toFixed(1)}⭐`);
            return;
        }
        var user2 = await User.getOrCreate(userPhoneKey);
        var session2 = getSession(userPhoneKey);
        if (session2.draft.from && session2.draft.to &&!session2.draft.time) {
            let qt = parseTimeQuick(lowerText);
            let qd = getRealDate(lowerText);
            if (qt || qd!== getNairobiNow().toISOString().split('T')[0] || lowerText.includes('tomorrow') || ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].some(d=>lowerText.includes(d)) || lowerText.includes('next week')) {
                if (qt) session2.draft.time = qt; else session2.draft.time = '09:00';
                session2.draft.date = qd;
                let displayDate = toDisplayDate(qd);
                await sendGupshupMessage(phoneJid, `Perfect, ${session2.draft.from} → ${session2.draft.to} at ${toDisplayTime(session2.draft.time)} ${displayDate} — creating...`);
                var rr = await RideRequest.createCustom(userPhoneKey, session2.draft);
                await sendGupshupMessage(phoneJid, `RIDE #${rr.id} CREATED\n${rr.from} → ${rr.to} at ${toDisplayTime(rr.time)} ${displayDate}\nAlerting drivers...`);
                var drvs = await User.getOnlineNearby(rr.from);
                var clean = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
                var filtered = drvs.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean;});
                for (let d of filtered) await sendGupshupMessage(d.phone, `#${rr.id} ${rr.from} → ${rr.to} | ${toDisplayTime(rr.time)} ${displayDate}\nReply ${rr.id} or TAKE ${rr.id}`);
                clearSession(userPhoneKey); return;
            } else { await sendGupshupMessage(phoneJid, `What time? Reply Now or Tomorrow 6 PM or Friday 9 AM`); return; }
        }
        var ai = await parseWithAI(text, session2.draft);
        if (ai.role==='rider' && ai.from && ai.to) {
            session2.draft.from = ai.from;
            session2.draft.to = ai.to;
            session2.draft.role='rider';
            session2.draft.date = getRealDate(ai.date||'today');
            session2.draft.time = getRealTime(ai.time||'now');
            if (!session2.draft.time || session2.draft.time==='Flexible') {
                await sendGupshupMessage(phoneJid, `Got it, ${session2.draft.from} → ${session2.draft.to}. What time? Reply Now or Tomorrow 6 PM or Friday 9 AM`);
                return;
            }
            var rideReq = await RideRequest.createCustom(userPhoneKey, session2.draft);
            let dispDate = toDisplayDate(session2.draft.date);
            await sendGupshupMessage(phoneJid, `RIDE #${rideReq.id} CREATED\n${rideReq.from} → ${rideReq.to} ${toDisplayTime(rideReq.time)} ${dispDate}\nAlerting drivers...`);
            var drivers = await User.getOnlineNearby(rideReq.from);
            var clean = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
            var f = drivers.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==clean;});
            for (let d of f) await sendGupshupMessage(d.phone, `#${rideReq.id} ${rideReq.from} → ${rideReq.to} | ${toDisplayTime(rideReq.time)} ${dispDate}\nReply ${rideReq.id}`);
            clearSession(userPhoneKey); return;
        }
        if (ai.role==='chat') {
            let reply = await answerGeneralQuestion(text, user2.location||session2.draft.from||"Juja");
            if (!reply) reply = `${getTimeGreeting()}! I'm Bett — I help students with rides.`;
            await sendGupshupMessage(phoneJid, reply);
            return;
        }
        if (ai.role==='command') {
            if (ai.command==='ONLINE') {
                await user2.setOnline(ai.from||session2.draft.from||"Juja",2);
                var nearby = await RideRequest.getNearby(user2.location);
                await sendGupshupMessage(phoneJid, `ONLINE: ${user2.location} | ${(user2.rating||5).toFixed(1)}⭐`);
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
            if (!session2.draft.from) await sendGupshupMessage(phoneJid, `Where are you riding from? Example: Juja`);
            else await sendGupshupMessage(phoneJid, `Okay, from ${session2.draft.from} — where to?`);
            return;
        }
        if (session2.draft.role==='rider' &&!session2.draft.time) { await sendGupshupMessage(phoneJid, `What time? Reply Now or Tomorrow 6 PM or Friday 9 AM`); return; }
        if (session2.draft.role==='rider') {
            var rideReq2 = await RideRequest.createCustom(userPhoneKey, session2.draft);
            await sendGupshupMessage(phoneJid, `RIDE #${rideReq2.id} CREATED\n${rideReq2.from} → ${rideReq2.to} ${toDisplayTime(rideReq2.time)} ${toDisplayDate(rideReq2.date)}`);
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
app.get('/',(req,res)=>{ res.send("Bett LIVE - Student Rides - /qr"); });
app.get('/clearall', async (req,res)=>{
    await RideRequest.destroy({ where: {} });
    await RideOffer.destroy({ where: {} });
    for (let k in activeChats) delete activeChats[k];
    for (let k in userSessions) delete userSessions[k];
    res.send("All rides deleted + memory cleared");
});
app.get('/cleardb', async (req,res)=>{ await sequelize.sync({ force: true }); res.send("Full DB wiped"); });
var PORT = process.env.PORT||10000;
app.listen(PORT,()=>{ console.log("Bett Running on "+PORT); });
