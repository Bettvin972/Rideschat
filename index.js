require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { sequelize, User, RideRequest, RideOffer } = require('./database');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

sequelize.sync({ alter: true }).then(()=>{ console.log("DB Synced"); }).catch(e=>{ console.error("DB Sync error:", e.message); });

let sock = null;
let qrLast = null;
const AUTH_PATH = path.join(__dirname, 'auth_info');

async function startWhatsApp() {
    if(!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Rideschat", "Chrome", "1.0"],
        shouldSyncHistoryMessage: () => false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        getMessage: async () => undefined
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if(qr) {
            qrLast = qr;
            qrcode.generate(qr, {small: true});
            console.log("SCAN THIS QR");
        }
        if(connection === 'open') { console.log('WhatsApp Connected!'); qrLast = null; }
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut;
            console.log('Closed, reconnect:', shouldReconnect);
            if(shouldReconnect) setTimeout(startWhatsApp, 3000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages ||!messages[0]) return;
            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;
            const remoteJid = msg.key.remoteJid || "";
            // FIXED: Allow @lid - new WhatsApp privacy IDs
            if (remoteJid === 'status@broadcast' || remoteJid.includes('@g.us')) return;
            if (msg.message.protocolMessage) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            if (!text) return;
            console.log(`MSG [${remoteJid}]: ${text}`);
            await handleRideLogic(remoteJid, text);
        } catch (e) {
            const m = e.message || "";
            if (m.includes('Bad MAC') || m.includes('SessionError') || m.includes('No matching')) return;
            console.error('upsert error:', m);
        }
    });
}
startWhatsApp();

process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Bad MAC') || err.message.includes('SessionError'))) return;
    console.error('Uncaught:', err);
});
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (msg.includes('Bad MAC') || msg.includes('SessionError') || msg.includes('No matching')) return;
    console.error('Unhandled:', reason);
});

function getRealDate(aiDate) {
    const now = new Date();
    if (!aiDate || aiDate.toLowerCase() === 'today') return now.toISOString().split('T')[0];
    if (aiDate.toLowerCase() === 'tomorrow') { var t = new Date(); t.setDate(now.getDate() + 1); return t.toISOString().split('T')[0]; }
    var days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    if (days.includes(aiDate.toLowerCase())) {
        var target = days.indexOf(aiDate.toLowerCase());
        var diff = (target - now.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        var d = new Date(); d.setDate(now.getDate() + diff);
        return d.toISOString().split('T')[0];
    }
    return aiDate;
}

var AI_PROMPT = 'You are Rideschat Kenya parser. Current: {TODAY_INFO} [{TODAY_DATE}]. Understand English, Swahili, Sheng. Translate to English JSON. Return JSON only: {"role":"rider|driver|command|greeting","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|RATING|null","takeId":number|null,"from":"string or null","to":"string or null","date":"YYYY-MM-DD or null","time":"HH:MM or null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":bool,"rating":number|null} Rules: If greeting like Hi/Hello/Sasa/Niaje set role greeting. tomorrow = {TOMORROW_DATE}. TAKE 1 -> command TAKE. Examples: Hi -> greeting, Need ride Juja to Nairobi tmrw 5pm -> rider, Need ride Thika to Ruiru tomorrow 8am -> rider, Driver ON near Juja -> command ONLINE, Driver ON near Nairobi CBD -> command ONLINE, TAKE 1 -> command TAKE takeId 1, 5 stars -> command RATING rating 5 Message: "{MSG}" JSON only.';

async function parseWithAI(msg) {
    var now = new Date(); var tomorrow = new Date(); tomorrow.setDate(now.getDate() + 1);
    var todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0];
    var prompt = AI_PROMPT.replaceAll("{TODAY_INFO}", todayInfo).replaceAll("{TODAY_DATE}", now.toISOString().split('T')[0]).replaceAll("{TOMORROW_DATE}", tomorrow.toISOString().split('T')[0]).replace("{MSG}", msg);
    var apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
    var models = ["gemini-2.0-flash", "gemini-1.5-flash"];
    for (var i=0;i<models.length;i++) {
        try {
            var url = "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent?key=" + apiKey;
            var res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } });
            var cleanContent = res.data.candidates[0].content.parts[0].text.trim().replace(/^```(json)?/, '').replace(/```$/, '').trim();
            var data = JSON.parse(cleanContent);
            if (data.date) data.date = getRealDate(data.date);
            return data;
        } catch (err) { if (i === models.length - 1) throw err; }
    }
}

async function sendGupshupMessage(toJid, messageText) {
    if (!toJid ||!sock) return;
    try {
        // FIXED: Use JID directly - supports both @lid and @s.whatsapp.net
        let jid = toJid;
        if (!jid.includes('@')) {
            jid = jid.replace('+','').trim() + '@s.whatsapp.net';
        }
        await sock.sendMessage(jid, { text: messageText });
        console.log('Sent to ' + jid);
    } catch (err) { console.error('Send error:', err.message); }
}

function formatRequests(reqs) {
    if (!reqs || reqs.length === 0) return "No active rides. Try: Need ride Juja to Nairobi tomorrow 5pm";
    return reqs.map(function(r){
        var girls = r.girls_only? ' GIRLS ONLY' : '';
        var contact = r.phone.includes('@')? r.phone : 'wa.me/' + r.phone;
        return r.id + ". " + r.from + "->" + r.to + " " + r.date + " " + (r.time || '') + " Bags:" + r.bags + girls + " " + contact;
    }).join('\n');
}
function formatOffers(offers) {
    if (!offers || offers.length === 0) return "No active offers.";
    return offers.map(function(o,i){
        var contact = o.phone.includes('@')? o.phone : 'wa.me/' + o.phone;
        return (i+1) + ". " + o.from + "->" + o.to + " " + o.date + " " + (o.time || '') + " " + o.seats + "seats KES" + o.price + " " + o.rating + " star " + contact;
    }).join('\n');
}

async function handleRideLogic(phoneJid, text) {
    try {
        var user = await User.getOrCreate(phoneJid);
        var ai = await parseWithAI(text);
        console.log("[" + phoneJid + "] -> AI: " + JSON.stringify(ai));
        if (ai.role === 'greeting' || (!ai.from &&!ai.to && (!ai.command || ai.command === 'null' || ai.command === null))) {
            await sendGupshupMessage(phoneJid, "Welcome to Rideschat Kenya!\n\nHow to use:\nRIDER: Need ride Juja to Nairobi tomorrow 5pm\nDRIVER: Driver ON near Juja\nTo accept: TAKE 1\nRate: 5 stars");
            return;
        }
        if (ai.role === 'rider' && (!ai.from ||!ai.to)) {
            await sendGupshupMessage(phoneJid, "Where to where? Example: Need ride Juja to Thika tomorrow 5pm");
            return;
        }
        if (ai.role === 'command') {
            if (ai.command === 'ONLINE') {
                await user.setOnline(ai.from || "Juja", 2);
                var nearby = await RideRequest.getNearby(user.location);
                await sendGupshupMessage(phoneJid, "Rideschat: ONLINE 2hrs near " + user.location + " on " + (ai.date || 'today') + "\nRating: " + user.rating.toFixed(1) + " star\n" + formatRequests(nearby) + "\nType TAKE <id> to accept ride");
            }
            if (ai.command === 'OFFLINE') { await user.setOffline(); await sendGupshupMessage(phoneJid, "Rideschat: OFFLINE. You won't get ride alerts."); }
            if (ai.command === 'SHOW_REQUESTS') { var nearby2 = await RideRequest.getNearby("Juja"); await sendGupshupMessage(phoneJid, "Rides near Juja:\n" + formatRequests(nearby2)); }
            if (ai.command === 'TAKE') {
                var ride = await RideRequest.findById(ai.takeId);
                if (ride) {
                    await ride.updateStatus("TAKEN");
                    await sendGupshupMessage(phoneJid, "You claimed ride " + ride.id + ". Rider: " + ride.phone + " - Call them now!");
                    await sendGupshupMessage(ride.phone, "Driver on the way! " + user.phone + " Rating: " + user.rating.toFixed(1) + " star - Contact: " + phoneJid + "\nFrom: " + ride.from + " To: " + ride.to);
                } else { await sendGupshupMessage(phoneJid, "Ride ID " + ai.takeId + " not found or already taken."); }
            }
            if (ai.command === 'RATING') { await user.addRating(ai.rating); await sendGupshupMessage(phoneJid, "Thanks! You rated " + ai.rating + " star"); }
            return;
        }
        if (ai.role === 'rider') {
            var rideReq = await RideRequest.createCustom(phoneJid, ai);
            var matches = await RideOffer.perfectMatch(rideReq);
            if (matches && matches.length > 0) {
                await sendGupshupMessage(phoneJid, "Rideschat: Found " + matches.length + " driver(s) for " + rideReq.date + " " + (rideReq.time || '') + "\n" + formatOffers(matches));
            } else {
                await sendGupshupMessage(phoneJid, "Rideschat: Booked! No driver online yet for " + rideReq.from + "->" + rideReq.to + " on " + rideReq.date + " " + (rideReq.time || '') + ". We will alert drivers near you.");
                var drivers = await User.getOnlineNearby(rideReq.from);
                for (var j=0;j<drivers.length;j++) {
                    await sendGupshupMessage(drivers[j].phone, "NEW RIDE near you! " + rideReq.from + "->" + rideReq.to + " " + rideReq.date + " " + (rideReq.time || '') + " Bags:" + rideReq.bags + " \nTAKE " + rideReq.id + " to accept\nRider: " + phoneJid);
                }
            }
            return;
        }
        if (ai.role === 'driver') {
            var offer = await RideOffer.createCustom(phoneJid, ai);
            var riders = await RideRequest.getMatchingRiders(offer);
            if (riders.length > 0) {
                await sendGupshupMessage(phoneJid, "Rideschat: " + riders.length + " rider(s) need " + offer.date + "!\n" + formatRequests(riders));
            } else {
                await sendGupshupMessage(phoneJid, "Offer posted: " + offer.from + "->" + offer.to + " " + offer.date + " " + (offer.time || '') + " - Waiting for riders.");
            }
        }
    } catch (err) { console.error('Error:', err.stack || err.message); }
}

app.get('/qr', function(req, res){
    if(!qrLast) return res.send("<h1>Connected! Bot Live</h1>");
    var qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qrLast);
    res.send("<h1>Scan with your Safaricom line</h1><p>WhatsApp > Linked Devices > Link a Device</p><img src='"+qrImage+"'/><p>Refresh after 20 sec</p>");
});
app.post('/webhook', function(req,res){ res.send('OK'); });
app.get('/ping', function(req, res){ res.send("Rideschat Kenya Alive"); });
app.get('/', function(req, res){ res.send("Rideschat Kenya LIVE - Go to /qr"); });
var PORT = process.env.PORT || 10000;
app.listen(PORT, function(){ console.log("Rideschat Kenya running on port " + PORT); });
