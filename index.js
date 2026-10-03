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

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Starting WA with version v${version.join('.')} (isLatest: ${isLatest})...`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Rideschat", "Chrome", "1.0.0"],
        shouldSyncHistoryMessage: () => false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        getMessage: async () => undefined
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrLast = qr;
            console.log("NEW QR READY - Go to /qr");
        }

        if (connection === 'open') {
            console.log('WhatsApp Connected!');
            qrLast = null;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message || '';
            console.log(`Closed, code: ${statusCode} msg: ${msg}`);

            qrLast = null;
            sock = null;

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('Session invalidated or logged out. Clearing auth_info directory...');
                if (fs.existsSync(AUTH_PATH)) {
                    fs.rmSync(AUTH_PATH, { recursive: true, force: true });
                }
            }

            console.log('Restarting connection in 5s...');
            setTimeout(startWhatsApp, 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages || !messages[0]) return;
            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;

            const remoteJid = msg.key.remoteJid || "";
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
    console.error('Uncaught:', err.message);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason);
    if (msg.includes('Bad MAC') || msg.includes('SessionError') || msg.includes('No matching')) return;
    console.error('Unhandled:', msg);
});

function getRealDate(aiDate) {
    const now = new Date();
    if (!aiDate || aiDate.toLowerCase() === 'today' || aiDate === 'null') return now.toISOString().split('T')[0];
    if (aiDate.toLowerCase() === 'tomorrow') {
        var t = new Date();
        t.setDate(now.getDate() + 1);
        return t.toISOString().split('T')[0];
    }
    var days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    if (days.includes(aiDate.toLowerCase())) {
        var target = days.indexOf(aiDate.toLowerCase());
        var diff = (target - now.getDay() + 7) % 7;
        if (diff === 0) diff = 7;
        var d = new Date();
        d.setDate(now.getDate() + diff);
        return d.toISOString().split('T')[0];
    }
    return aiDate;
}

// Clean phone numbers by removing @lid or @s.whatsapp.net for clean output display
function cleanContactNumber(jid) {
    if (!jid) return "Contact user directly";
    if (jid.includes('@lid')) {
        return "WhatsApp User (LID)";
    }
    const cleanNum = jid.split('@')[0].replace('+', '').trim();
    return `wa.me/${cleanNum}`;
}

var AI_PROMPT = 'You are Rideschat Kenya conversational parser & assistant. Current: {TODAY_INFO} [{TODAY_DATE}]. Understand English, Swahili, and Sheng. Return strictly JSON only: {"role":"rider|driver|command|chat","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|RATING|null","takeId":number|null,"from":"string or null","to":"string or null","date":"YYYY-MM-DD or null","time":"HH:MM or null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":bool,"rating":number|null,"reply":"string or null"} Rules: If the user message is a greeting, small talk, acknowledgement ("okay", "cool", "thanks"), or general question, set role to "chat" and provide a warm, concise response in "reply" guiding them on how to request a ride or post an offer naturally. Message: "{MSG}"';

async function parseWithAI(msg) {
    var now = new Date();
    var tomorrow = new Date();
    tomorrow.setDate(now.getDate() + 1);
    var todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0];
    var prompt = AI_PROMPT.replaceAll("{TODAY_INFO}", todayInfo)
                           .replaceAll("{TODAY_DATE}", now.toISOString().split('T')[0])
                           .replaceAll("{TOMORROW_DATE}", tomorrow.toISOString().split('T')[0])
                           .replace("{MSG}", msg);

    var apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");

    var models = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];

    for (var i = 0; i < models.length; i++) {
        try {
            var url = "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent?key=" + apiKey;
            var res = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    responseMimeType: "application/json"
                }
            });

            var cleanContent = res.data.candidates[0].content.parts[0].text.trim();
            var data = JSON.parse(cleanContent);
            if (data.date) data.date = getRealDate(data.date);
            return data;
        } catch (err) {
            console.error("Gemini API Error details:", err.response ? err.response.data : err.message);
            if (i === models.length - 1) throw err;
        }
    }
}

async function sendGupshupMessage(toJid, messageText) {
    if (!toJid || !sock) return;
    try {
        let jid = toJid;
        if (!jid.includes('@')) {
            jid = jid.replace('+', '').trim() + '@s.whatsapp.net';
        }
        await sock.sendMessage(jid, { text: messageText });
        console.log('Sent to ' + jid);
    } catch (err) {
        console.error('Send error:', err.message);
    }
}

function formatRequests(reqs) {
    if (!reqs || reqs.length === 0) return "No active rides right now.";
    return reqs.map(function (r) {
        var girls = r.girls_only ? ' GIRLS ONLY' : '';
        var contact = cleanContactNumber(r.phone);
        return r.id + ". " + r.from + " -> " + r.to + " (" + (r.date || 'Today') + " " + (r.time || '') + ") Bags:" + r.bags + girls + "\nContact: " + contact;
    }).join('\n\n');
}

function formatOffers(offers) {
    if (!offers || offers.length === 0) return "No active offers right now.";
    return offers.map(function (o, i) {
        var contact = cleanContactNumber(o.phone);
        return (i + 1) + ". " + o.from + " -> " + o.to + " (" + (o.date || 'Today') + " " + (o.time || '') + ") " + o.seats + " seats - KES " + o.price + " (" + o.rating + "★)\nContact: " + contact;
    }).join('\n\n');
}

async function handleRideLogic(phoneJid, text) {
    try {
        const lowerText = text.toLowerCase().trim();
        
        // Suppress repeated greetings/menus on simple conversational acknowledgments
        const acknowledgements = ['okay', 'ok', 'cool', 'thanks', 'asante', 'got it', 'sure', 'alright', 'thx', '👍'];
        if (acknowledgements.includes(lowerText)) {
            return; // Soft silence on basic acknowledgments
        }

        var user = await User.getOrCreate(phoneJid);
        var ai = await parseWithAI(text);
        console.log("[" + phoneJid + "] -> AI: " + JSON.stringify(ai));

        // Use AI dynamically generated dynamic conversational responses for chatter/greetings
        if (ai.role === 'chat' || ai.role === 'greeting' || (!ai.from && !ai.to && (!ai.command || ai.command === 'null' || ai.command === null))) {
            var chatReply = ai.reply || "Sasa! Welcome to Rideschat Kenya 🇰🇪\n\nNeed a ride or offering seats? Just text where you're heading (e.g., 'Need ride Juja to Nairobi tomorrow 5pm' or 'Driver ON near Juja').";
            await sendGupshupMessage(phoneJid, chatReply);
            return;
        }

        if (ai.role === 'rider' && (!ai.from || !ai.to)) {
            await sendGupshupMessage(phoneJid, "Where are you coming from and where to? Example: 'Need ride Juja to Thika tomorrow 5pm'");
            return;
        }

        if (ai.role === 'command') {
            if (ai.command === 'ONLINE') {
                await user.setOnline(ai.from || "Juja", 2);
                var nearby = await RideRequest.getNearby(user.location);
                await sendGupshupMessage(phoneJid, "Rideschat: ONLINE 2hrs near " + user.location + " (" + (ai.date || 'Today') + ")\nRating: " + user.rating.toFixed(1) + "★\n\n" + formatRequests(nearby) + "\n\nReply TAKE <id> to accept a ride.");
            }
            if (ai.command === 'OFFLINE') {
                await user.setOffline();
                await sendGupshupMessage(phoneJid, "Rideschat: You are now OFFLINE. You won't get new ride alerts.");
            }
            if (ai.command === 'SHOW_REQUESTS') {
                var nearby2 = await RideRequest.getNearby("Juja");
                await sendGupshupMessage(phoneJid, "Rides near Juja:\n\n" + formatRequests(nearby2));
            }
            if (ai.command === 'TAKE') {
                var ride = await RideRequest.findById(ai.takeId);
                if (ride) {
                    await ride.updateStatus("TAKEN");
                    await sendGupshupMessage(phoneJid, "You claimed ride #" + ride.id + "!\nRider Contact: " + cleanContactNumber(ride.phone));
                    await sendGupshupMessage(ride.phone, "Driver on the way!\nDriver Rating: " + user.rating.toFixed(1) + "★\nContact: " + cleanContactNumber(phoneJid) + "\nRoute: " + ride.from + " to " + ride.to);
                } else {
                    await sendGupshupMessage(phoneJid, "Ride ID " + ai.takeId + " not found or already taken.");
                }
            }
            if (ai.command === 'RATING') {
                await user.addRating(ai.rating);
                await sendGupshupMessage(phoneJid, "Thanks for the feedback! Rated " + ai.rating + " stars.");
            }
            return;
        }

        if (ai.role === 'rider') {
            var rideReq = await RideRequest.createCustom(phoneJid, ai);
            var matches = await RideOffer.perfectMatch(rideReq);
            var displayDate = rideReq.date || 'Today';

            if (matches && matches.length > 0) {
                await sendGupshupMessage(phoneJid, "Rideschat: Found " + matches.length + " driver(s) for " + displayDate + " " + (rideReq.time || '') + "\n\n" + formatOffers(matches));
            } else {
                await sendGupshupMessage(phoneJid, "Rideschat: Booked! Search registered for " + rideReq.from + " -> " + rideReq.to + " (" + displayDate + " " + (rideReq.time || '') + "). We'll alert available drivers!");
                var drivers = await User.getOnlineNearby(rideReq.from);
                for (var j = 0; j < drivers.length; j++) {
                    await sendGupshupMessage(drivers[j].phone, "NEW RIDE ALERT near you!\nRoute: " + rideReq.from + " -> " + rideReq.to + " (" + displayDate + " " + (rideReq.time || '') + ")\nBags: " + rideReq.bags + "\nReply TAKE " + rideReq.id + " to accept!");
                }
            }
            return;
        }

        if (ai.role === 'driver') {
            var offer = await RideOffer.createCustom(phoneJid, ai);
            var riders = await RideRequest.getMatchingRiders(offer);
            var displayOfferDate = offer.date || 'Today';

            if (riders.length > 0) {
                await sendGupshupMessage(phoneJid, "Rideschat: " + riders.length + " rider(s) found for " + displayOfferDate + "!\n\n" + formatRequests(riders));
            } else {
                await sendGupshupMessage(phoneJid, "Offer posted: " + offer.from + " -> " + offer.to + " (" + displayOfferDate + " " + (offer.time || '') + "). Waiting for riders.");
            }
        }
    } catch (err) {
        console.error('Error:', err.stack || err.message);
    }
}

app.get('/qr', function (req, res) {
    if (!qrLast) return res.send("<h1>Connected! Bot Live</h1>");
    var qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qrLast);
    res.send("<h1>Scan with your Safaricom line</h1><p>WhatsApp > Linked Devices > Link a Device</p><img src='" + qrImage + "'/><p>Refresh after 20 sec</p>");
});

app.post('/webhook', function (req, res) { res.send('OK'); });
app.get('/ping', function (req, res) { res.send("Rideschat Kenya Alive"); });
app.get('/', function (req, res) { res.send("Rideschat Kenya LIVE - Go to /qr"); });

var PORT = process.env.PORT || 10000;
app.listen(PORT, function () { console.log("Rideschat Kenya running on port " + PORT); });
