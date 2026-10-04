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

sequelize.sync({ alter: true }).then(() => console.log("DB Synced")).catch(e => console.error("DB Sync error:", e.message));

let sock = null;
let qrLast = null;
const AUTH_PATH = path.join(__dirname, 'auth_info');
const userSessions = {};

function getSession(phone) {
  if (!userSessions[phone]) userSessions[phone] = { draft: {}, lastUpdated: Date.now() };
  return userSessions[phone];
}
function clearSession(phone) { delete userSessions[phone]; }

function getRealDate(aiDate) {
  if (!aiDate) return null;
  const lower = aiDate.toLowerCase();
  const today = new Date();
  if (lower === 'today') return today.toISOString().split('T')[0];
  if (lower === 'tomorrow') { let d = new Date(); d.setDate(today.getDate()+1); return d.toISOString().split('T')[0]; }
  return aiDate; // already YYYY-MM-DD
}

// --- PROMPT ---
const AI_PROMPT = `
You are Rideschat parser. Today is {TODAY_INFO} (YYYY-MM-DD is {TODAY_DATE}).
Extract ride info from message: "{MSG}"

Return ONLY JSON:
{
  "role": "rider" or "driver" or "command" or "chat",
  "command": "TAKE" or "ONLINE" or "OFFLINE" or null,
  "takeId": number or null,
  "from": string or null,
  "to": string or null,
  "date": "YYYY-MM-DD" or "today" or "tomorrow" or null,
  "time": "HH:mm" 24h or null,
  "seats": number or null,
  "bags": number,
  "girls_only": boolean,
  "pool_allowed": boolean,
  "rating": number or null,
  "reply": string or null for chat
}
Rules:
- "Need ride Juja to Thika tomorrow 5pm" -> from Juja, to Thika, date tomorrow, time 17:00
- "TAKE 1" -> command TAKE, takeId 1
- "Driver ON 4 seats Juja" -> command ONLINE, seats 4, from Juja
`;

// --- FIXED AI PARSER (GROQ ONLY) ---
async function parseWithAI(msg) {
  const lower = msg.toLowerCase().trim();

  // 1. OFFLINE FAST PATH - no API cost
  const takeMatch = lower.match(/^take\s*(\d+)/);
  if (takeMatch) return { role: "command", command: "TAKE", takeId: parseInt(takeMatch[1]), from: null, to: null, date: null, time: null, seats: null, bags: 0, girls_only: false, pool_allowed: true, rating: null, reply: null };
  if (lower === "on" || lower.includes("driver on") || lower.includes("online")) return { role: "command", command: "ONLINE", from: "Juja", to: null, date: null, time: null, seats: 4, bags: 0, girls_only: false, pool_allowed: true, rating: null, reply: null };
  if (lower === "off" || lower.includes("driver off") || lower.includes("offline")) return { role: "command", command: "OFFLINE", from: null, to: null, date: null, time: null, seats: null, bags: 0, girls_only: false, pool_allowed: true, rating: null, reply: null };

  // 2. GROQ CALL - current live model
  const now = new Date();
  const todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0];
  const prompt = AI_PROMPT.replaceAll("{TODAY_INFO}", todayInfo).replaceAll("{TODAY_DATE}", now.toISOString().split('T')[0]).replace("{MSG}", msg);

  try {
    if (!process.env.GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY in Render env");

    const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "openai/gpt-oss-20b", // <-- CURRENT MODEL, NOT llama
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1
    }, {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
    });

    let data = JSON.parse(res.data.choices[0].message.content);
    if (data.date) data.date = getRealDate(data.date);
    console.log("Groq OK [" + "openai/gpt-oss-20b" + "]:", data);
    return data;

  } catch (e) {
    const errDetail = e.response?.data?.error?.message || e.message;
    console.error("Groq Error:", errDetail);
    // fallback to simple regex extract
    const fromTo = lower.match(/(?:from\s+)?(\w+)\s+to\s+(\w+)/);
    return {
      role: "rider",
      from: fromTo? fromTo[1] : null,
      to: fromTo? fromTo[2] : null,
      date: lower.includes("tomorrow")? getRealDate("tomorrow") : getRealDate("today"),
      time: null, seats: null, bags: 0, girls_only: false, pool_allowed: true, rating: null, reply: null
    };
  }
}

// --- WHATSAPP LOGIC (keep your existing below) ---
//... (leave your startSock, handleMessage, app.get etc as is, just replace parseWithAI)

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrLast = qr; console.log("New QR generated"); }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') { console.log("WhatsApp Connected"); }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const phone = m.key.remoteJid;
      const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
      if (!text) continue;
      console.log("Incoming:", phone, text);
      try {
        const parsed = await parseWithAI(text);
        console.log("Merged Draft:", parsed);
        // TODO: your existing logic to save to DB and reply
        if (sock) await sock.sendMessage(phone, { text: `Parsed: ${JSON.stringify(parsed)}` });
      } catch (err) { console.error("Handle error", err); }
    }
  });
}
startSock();

app.get('/', (req, res) => res.send(`Rideschat running. QR: ${qrLast? 'ready' : 'not ready'}`));
app.get('/qr', async (req, res) => {
  if (!qrLast) return res.send("No QR - already connected");
  const QRCode = require('qrcode');
  const qrImg = await QRCode.toDataURL(qrLast);
  res.send(`<img src="${qrImg}"><p>Scan with WhatsApp</p>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on " + PORT));
