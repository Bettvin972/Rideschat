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

function toBoldSans(text) {
    const sansBoldMap = {
        'A':'𝗔','B':'𝗕','C':'𝗖','D':'𝗗','E':'𝗘','F':'𝗙','G':'𝗚','H':'𝗛','I':'𝗜','J':'𝗝','K':'𝗞','L':'𝗟','M':'𝗠',
        'N':'𝗡','O':'𝗢','P':'𝗣','Q':'𝗤','R':'𝗥','S':'𝗦','T':'𝗧','U':'𝗨','V':'𝗩','W':'𝗪','X':'𝗫','Y':'𝗬','Z':'𝗭',
        'a':'𝗮','b':'𝗯','c':'𝗰','d':'𝗱','e':'𝗲','f':'𝗳','g':'𝗴','h':'𝗵','i':'𝗶','j':'𝗷','k':'𝗸','l':'𝗹','m':'𝗺',
        'n':'𝗻','o':'𝗼','p':'𝗽','q':'𝑞','r':'𝗿','s':'𝘀','t':'𝘁','u':'𝘂','v':'𝘃','w':'𝘄','x':'𝘅','y':'𝘆','z':'𝘇',
        '0':'𝟬','1':'𝟭','2':'𝟮','3':'𝟯','4':'𝟰','5':'𝟱','6':'𝟲','7':'𝟩','8':'𝟴','9':'𝟡'
    };
    return text.split('').map(char => sansBoldMap[char] || char).join('');
}

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Starting WA with version v${version.join('.')} (isLatest: ${isLatest})...`);
    sock = makeWASocket({
        version, auth: state, logger: pino({ level: 'silent' }),
        printQRInTerminal: false, browser: ["Rideschat", "Chrome", "1.0.0"],
        shouldSyncHistoryMessage: () => false, syncFullHistory: false, markOnlineOnConnect: false,
        getMessage: async () => undefined
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { qrLast = qr; console.log("NEW QR READY - Go to /qr"); }
        if (connection === 'open') { console.log('WhatsApp Connected!'); qrLast = null; }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message || '';
            console.log(`Closed, code: ${statusCode} msg: ${msg}`);
            qrLast = null; sock = null;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { recursive: true, force: true });
            }
            setTimeout(startWhatsApp, 5000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages ||!messages[0]) return;
            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;
            const remoteJid = msg.key.remoteJid || "";
            if (remoteJid === 'status@broadcast' || remoteJid.includes('@g.us')) return;
            if (msg.message.protocolMessage) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            if (!text) return;
            let realPhone = remoteJid;
            if (remoteJid.includes('@lid')) {
                if (msg.key.participant &&!msg.key.participant.includes('@lid')) realPhone = msg.key.participant;
                else if (msg.key.remoteJidAlt &&!msg.key.remoteJidAlt.includes('@lid')) realPhone = msg.key.remoteJidAlt;
            }
            console.log(`MSG [${remoteJid}] (Extracted: ${realPhone}): ${text}`);
            await handleRideLogic(remoteJid, text, realPhone);
        } catch (e) {
            const m = e.message || "";
            if (m.includes('Bad MAC') || m.includes('SessionError') || m.includes('No matching')) return;
            console.error('upsert error:', m);
        }
    });
}
startWhatsApp();

process.on('uncaughtException', (err) => { if (err.message && (err.message.includes('Bad MAC') || err.message.includes('SessionError'))) return; console.error('Uncaught:', err.message); });
process.on('unhandledRejection', (reason) => { const msg = reason?.message || String(reason); if (msg.includes('Bad MAC') || msg.includes('SessionError') || msg.includes('No matching')) return; console.error('Unhandled:', msg); });

function getRealDate(aiDate) {
    const now = new Date();
    if (!aiDate || aiDate.toLowerCase() === 'today' || aiDate.toLowerCase() === 'now' || aiDate === 'null') return now.toISOString().split('T')[0];
    if (aiDate.toLowerCase() === 'tomorrow') { var t = new Date(); t.setDate(now.getDate() + 1); return t.toISOString().split('T')[0]; }
    var days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    if (days.includes(aiDate.toLowerCase())) {
        var target = days.indexOf(aiDate.toLowerCase());
        var diff = (target - now.getDay() + 7) % 7; if (diff === 0) diff = 7;
        var d = new Date(); d.setDate(now.getDate() + diff); return d.toISOString().split('T')[0];
    }
    return aiDate;
}
function cleanContactNumber(jid) {
    if (!jid) return "📱 _Contact via Bot_";
    if (jid.includes('@lid')) return "📱 *Direct Connection via Bot*";
    const cleanNum = jid.split('@')[0].replace(/[^0-9]/g, '');
    return cleanNum? `https://wa.me/${cleanNum}` : "📱 *Direct Connection via Bot*";
}

// ✅ NEW SMART PROMPT - handles greetings + general Qs + rides
var SYSTEM_PROMPT = `You are Rideschat Kenya, friendly WhatsApp assistant. Current: {TODAY_INFO} [{TODAY_DATE}]. Draft: {CONTEXT_DRAFT}

Classify message into JSON:

1. GREETING: "Hi","Sasa","Mambo","Niaje","Hello","Hey","Sasa bro","Poa"
-> {"role":"chat","reply":"👋 Sasa! Karibu Rideschat Kenya 🇰🇪\\n\\nI help riders & drivers connect.\\n\\nJust say: 'Need ride FROM to TO at TIME'\\nEg: 'Need ride Juja to Thika tomorrow 9am'\\n\\nOr ask: 'How does it work?'"}

2. GENERAL QUESTION: "What is Rideschat?","How does it work?","Fare?","Is it safe?","Who are you?","Bei gani?","Explain"
-> {"role":"chat","reply":"[Write 2-3 lines helpful answer in Swahili/Sheng mix. Rideschat connects riders/drivers via WhatsApp, driver sets fare 300-600 KES, you see rating, you contact directly. No commission. Safe because we show contacts & ratings.]"}

3. RIDE: "Need ride Juja to Thika","Juja","Olenguruone","Juja to Olenguruone tomorrow 3pm"
-> extract from/to/date/time. Single location like "Juja" -> from="Juja", to=null.

4. COMMAND: "TAKE 1","ONLINE","OFFLINE"

Return ONLY valid JSON:
{"role":"rider|driver|command|chat","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|RATING|null","takeId":number|null,"from":string|null,"to":string|null,"date":"YYYY-MM-DD|null","time":"HH:MM|null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":true,"rating":null,"reply":string|null}

Rules: If message is single word location, return it as from. Preserve draft if present.
`;

async function parseWithAI(msg, contextDraft = {}) {
    var now = new Date();
    var tomorrow = new Date(); tomorrow.setDate(now.getDate() + 1);
    var todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0];
    var systemPrompt = SYSTEM_PROMPT.replaceAll("{TODAY_INFO}", todayInfo)
                                  .replaceAll("{TODAY_DATE}", now.toISOString().split('T')[0])
                                  .replaceAll("{TOMORROW_DATE}", tomorrow.toISOString().split('T')[0])
                                  .replaceAll("{CONTEXT_DRAFT}", JSON.stringify(contextDraft));
    var userPrompt = `Message: "${msg}"`;
    var apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY missing");

    var models = ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "qwen/qwen3.6-27b"];
    for (var i = 0; i < models.length; i++) {
        try {
            var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
                {
                    model: models[i],
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                    temperature: 0.2,
                    response_format: { type: "json_object" }
                },
                { headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" } }
            );
            var data = JSON.parse(res.data.choices[0].message.content.trim());
            if (data.date) data.date = getRealDate(data.date);
            console.log(`Groq OK [${models[i]}]:`, data);
            return data;
        } catch (err) {
            var errMsg = err.response?.data?.error?.message || err.message;
            console.warn(`Groq API [${models[i]}] Failed: ${errMsg}`);
            if (i === models.length - 1) throw err;
        }
    }
}

// ✅ NEW - answers open questions
async function answerGeneralQuestion(question) {
    try {
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b",
            messages: [
                { role: "system", content: "You are Rideschat Kenya. Answer in 2-3 lines max, friendly Kenyan style (mix English/Swahili). We connect riders & drivers via WhatsApp bot. Drivers post offers, riders request. Fare 300-600 KES typical, driver sets it. Safety: we show rating & you chat direct. No app needed." },
                { role: "user", content: question }
            ],
            temperature: 0.7
        }, { headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch (e) { return null; }
}

async function sendGupshupMessage(toJid, messageText) {
    if (!toJid ||!sock) return;
    try {
        let jid = toJid;
        if (!jid.includes('@')) jid = jid.replace('+', '').trim() + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: messageText });
        console.log('Sent to ' + jid);
    } catch (err) { console.error('Send error:', err.message); }
}

function formatRequests(reqs) {
    if (!reqs || reqs.length === 0) return "```No active ride requests right now.```";
    return reqs.map(function (r) {
        var girls = r.girls_only? ' 🚺 *[GIRLS ONLY]*' : '';
        var contact = cleanContactNumber(r.phone);
        return `🆔 *TRIP #${r.id}*\n📍 *Route:* ${r.from} ➔ ${r.to}\n📅 *When:* \`${r.date || 'Today'}\` at \`${r.time || 'Flexible'}\`\n🧳 *Bags:* ${r.bags}${girls}\n👤 *Contact:* ${contact}\n\n👉 _Reply \`TAKE ${r.id}\` to accept_`;
    }).join('\n\n═════════════════\n\n');
}
function formatOffers(offers) {
    if (!offers || offers.length === 0) return "```No active driver offers right now.```";
    return offers.map(function (o, i) {
        var contact = cleanContactNumber(o.phone);
        return `🚘 *OFFER #${i + 1}*\n📍 *Route:* ${o.from} ➔${o.to}\n📅 *When:* \`${o.date || 'Today'}\` at \`${o.time || 'Flexible'}\`\n💺 *Available:* ${o.seats} seat(s)\n💵 *Fare:* KES ${o.price} (${o.rating}⭐)\n👤 *Contact:* ${contact}`;
    }).join('\n\n═════════════════\n\n');
}

async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        const userPhoneKey = realPhone || phoneJid;
        const acknowledgements = ['okay', 'ok', 'cool', 'thanks', 'asante', 'got it', 'sure', 'alright', 'thx', '👍'];
        if (acknowledgements.includes(lowerText)) return;
        const takeMatch = lowerText.match(/^take\s*(\d+)$/i);
        var user = await User.getOrCreate(userPhoneKey);
        var session = getSession(userPhoneKey);
        var ai = await parseWithAI(text, session.draft);

        // ✅ FIXED CHAT HANDLING - greetings + general Qs
        if (ai.role === 'chat') {
            if (ai.reply && ai.reply.length > 5) {
                await sendGupshupMessage(phoneJid, ai.reply);
                return;
            }
            const genAns = await answerGeneralQuestion(text);
            const finalReply = genAns || `👋 ${toBoldSans("WELCOME TO RIDESCHAT KENYA!")}\n\nI connect riders & drivers.\n\nJust say: "Need ride from Juja to Thika at 3 PM"\n\nAsk me: "How does it work?"`;
            await sendGupshupMessage(phoneJid, finalReply);
            return;
        }

        // ✅ FIXED SMART MERGE - Juja + Olenguruone = Juja->Olenguruone
        let newFrom = ai.from || null;
        let newTo = ai.to || null;
        if (session.draft.from &&!session.draft.to && newFrom &&!newTo) {
            newTo = newFrom;
            newFrom = session.draft.from;
        }
        if (session.draft.from && session.draft.to && newFrom &&!newTo && newFrom!== session.draft.from) {
            // user updating destination
            newTo = newFrom;
            newFrom = session.draft.from;
        }

        session.draft = {
            role: ai.role || session.draft.role || 'rider',
            from: newFrom || session.draft.from || null,
            to: newTo || session.draft.to || null,
            date: ai.date || session.draft.date || null,
            time: ai.time || session.draft.time || null,
            bags: ai.bags?? session.draft.bags?? 0,
            girls_only: ai.girls_only?? session.draft.girls_only?? false
        };

        if (takeMatch) { ai.role = 'command'; ai.command = 'TAKE'; ai.takeId = parseInt(takeMatch[1], 10); }
        console.log("[" + phoneJid + "] -> Merged Draft: " + JSON.stringify(session.draft));

        if (ai.role === 'command') {
            if (ai.command === 'ONLINE') {
                await user.setOnline(ai.from || session.draft.from || "Juja", 2);
                var nearby = await RideRequest.getNearby(user.location);
                await sendGupshupMessage(phoneJid, `🟢 ${toBoldSans("DRIVER STATUS: ONLINE")}\n📍 *Location:* Near ${user.location}\n⭐ *Rating:*${user.rating.toFixed(1)} / 5.0\n\n${toBoldSans("AVAILABLE RIDES NEAR YOU:")}\n\n${formatRequests(nearby)}`);
            }
            if (ai.command === 'OFFLINE') {
                await user.setOffline();
                await sendGupshupMessage(phoneJid, `🔴 ${toBoldSans("DRIVER STATUS: OFFLINE")}`);
            }
            if (ai.command === 'SHOW_REQUESTS') {
                var nearby2 = await RideRequest.getNearby("Juja");
                await sendGupshupMessage(phoneJid, `📋 ${toBoldSans("AVAILABLE RIDES NEAR JUJA:")}\n\n${formatRequests(nearby2)}`);
            }
            if (ai.command === 'TAKE') {
                var ride = await RideRequest.findById(ai.takeId);
                if (ride && ride.status === 'PENDING') {
                    await ride.updateStatus("TAKEN");
                    const riderContactStr = cleanContactNumber(ride.phone);
                    const driverContactStr = cleanContactNumber(userPhoneKey);
                    var timeStr = ride.time? ride.time : 'Flexible';
                    await sendGupshupMessage(phoneJid, `🎉 ${toBoldSans("TRIP MATCHED!")}\n\n📍 *Route:* ${ride.from} ➔${ride.to}\n📅 *When:* \`${ride.date || 'Today'}\` at \`${timeStr}\`\n\n👤 *Rider Contact:* ${riderContactStr}`);
                    await sendGupshupMessage(ride.phone, `🚘 ${toBoldSans("DRIVER ASSIGNED!")}\n\nTrip *${ride.from}* to *${ride.to}* accepted.\n\n⭐ *Rating:*${user.rating.toFixed(1)}\n📱 *Driver:* ${driverContactStr}`);
                } else {
                    await sendGupshupMessage(phoneJid, `❌ *Ride #${ai.takeId}* already taken.`);
                }
            }
            if (ai.command === 'RATING') {
                await user.addRating(ai.rating);
                await sendGupshupMessage(phoneJid, `⭐ Thank you! You rated ${ai.rating} stars.`);
            }
            return;
        }

        if (session.draft.role === 'rider' && (!session.draft.from ||!session.draft.to)) {
            if (!session.draft.from) {
                await sendGupshupMessage(phoneJid, `📍 ${toBoldSans("WHERE FROM?")}\n\nTell me your origin.\nEg: "Juja"`);
            } else {
                await sendGupshupMessage(phoneJid, `📍 ${toBoldSans("WHERE TO?")}\n\nYou are in *${session.draft.from}*, where are you going?\nEg: "Thika" or "Nairobi"`);
            }
            return;
        }
        if (session.draft.role === 'rider' &&!session.draft.time) {
            await sendGupshupMessage(phoneJid, `⏰ ${toBoldSans("WHAT TIME?")}\n\nLeaving when?\nEg: "Now" or "Tomorrow 9am" or "3:30 PM"`);
            return;
        }

        if (session.draft.role === 'rider') {
            var rideReq = await RideRequest.createCustom(userPhoneKey, session.draft);
            var matches = await RideOffer.perfectMatch(rideReq);
            var displayDate = rideReq.date || 'Today';
            var timeStrReq = rideReq.time? rideReq.time : 'Flexible';
            if (matches && matches.length > 0) {
                await sendGupshupMessage(phoneJid, `✅ ${toBoldSans("FOUND DRIVERS!")}\n\n${formatOffers(matches)}`);
            } else {
                await sendGupshupMessage(phoneJid, `📝 ${toBoldSans("RIDE REQUEST CREATED!")} *(ID: #${rideReq.id})*\n📍 *Route:* ${rideReq.from} ➔ ${rideReq.to}\n📅 *Date:* \`${displayDate}\` at \`${timeStrReq}\`\n\n_Alerting drivers..._`);
                var drivers = await User.getOnlineNearby(rideReq.from);
                var currentRiderClean = userPhoneKey.split('@')[0].replace(/[^0-9]/g, '');
                var filteredDrivers = drivers.filter(d => { var driverClean = (d.phone || '').split('@')[0].replace(/[^0-9]/g, ''); return driverClean!== currentRiderClean; });
                for (var j = 0; j < filteredDrivers.length; j++) {
                    await sendGupshupMessage(filteredDrivers[j].phone, `🔔 ${toBoldSans("NEW REQUEST NEAR YOU!")}\n\n📍 *Route:* ${rideReq.from} ➔ ${rideReq.to}\n📅 *When:* \`${displayDate}\` at \`${timeStrReq}\`\n\n👉 Reply \`TAKE ${rideReq.id}\` to accept!`);
                }
            }
            clearSession(userPhoneKey); return;
        }
        if (ai.role === 'driver') {
            var offer = await RideOffer.createCustom(userPhoneKey, ai);
            var riders = await RideRequest.getMatchingRiders(offer);
            if (riders.length > 0) {
                await sendGupshupMessage(phoneJid, `🚘 ${toBoldSans("MATCHING RIDERS!")}\n\n${formatRequests(riders)}`);
            } else {
                await sendGupshupMessage(phoneJid, `🚘 ${toBoldSans("OFFER POSTED!")}\n📍 *Route:* ${offer.from} ➔ ${offer.to}\n📅 *Date:* \`${offer.date || 'Today'}\` at \`${offer.time || 'Flexible'}\`\n\n_Alerting riders soon._`);
            }
            clearSession(userPhoneKey);
        }
    } catch (err) { console.error('Error:', err.stack || err.message); }
}

setInterval(async () => {
    try { if (RideRequest.clearExpired && RideOffer.clearExpired) { await RideRequest.clearExpired(); await RideOffer.clearExpired(); } } catch (e) { console.error('[CRON]', e.message); }
}, 15 * 60 * 1000);

app.get('/qr', function (req, res) {
    if (!qrLast) return res.send("<h1>Connected! Bot Live</h1>");
    var qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qrLast);
    res.send("<h1>Scan Safaricom line</h1><p>WhatsApp > Linked Devices > Link</p><img src='" + qrImage + "'/>");
});
app.post('/webhook', function (req, res) { res.send('OK'); });
app.get('/ping', function (req, res) { res.send("Rideschat Kenya Alive"); });
app.get('/', function (req, res) { res.send("Rideschat Kenya LIVE - Go to /qr"); });
var PORT = process.env.PORT || 10000;
app.listen(PORT, function () { console.log("Rideschat Kenya running on port " + PORT); });
