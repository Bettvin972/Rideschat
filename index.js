require('dotenv').config()
const express = require('express')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const { sequelize, User, RideRequest, RideOffer } = require('./database')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

sequelize.sync({ alter: true }).then(function(){ console.log("DB Synced") }).catch(function(e){ console.error("DB Sync error:", e.message) })

let sock = null
let qrLast = null

// FIXED PATH - matches your disk mount on Render
const AUTH_PATH = path.join(__dirname, 'auth_info')

async function startWhatsApp() {
    if(!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH)
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["Rideschat", "Chrome", "1.0"],
        // This prevents crash on Bad MAC
        shouldIgnoreJid: jid => jid.includes('@lid') || jid === 'status@broadcast',
        getMessage: async () => undefined
    })
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if(qr) {
            qrLast = qr
            qrcode.generate(qr, {small: true})
            console.log("===== SCAN THIS QR WITH SAFARICOM LINE =====")
        }
        if(connection === 'open') { console.log('✅ WhatsApp Connected!'); qrLast = null }
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode!== DisconnectReason.loggedOut
            console.log('Connection closed, reconnecting:', shouldReconnect)
            if(shouldReconnect) setTimeout(startWhatsApp, 3000)
        }
    })

    // FIXED MESSAGE HANDLER
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages ||!messages[0]) return
            const msg = messages[0]

            // 1. Ignore if no message content
            if(!msg.message) return

            // 2. Ignore own messages
            if(msg.key.fromMe) return

            // 3. Ignore LID and status - THIS FIXES YOUR Bad MAC ERROR
            const remoteJid = msg.key.remoteJid || ""
            if (remoteJid.includes('@lid') || remoteJid === 'status@broadcast' || remoteJid.includes('@g.us')) return

            // 4. Ignore Baileys protocol messages
            if (msg.message.protocolMessage) return

            const phone = remoteJid.replace('@s.whatsapp.net','').replace('@c.us','')
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ""
            if(!text) return

            console.log(`MSG [${phone}]: ${text}`)
            await handleRideLogic(phone.trim(), text)

        } catch (e) {
            // Never crash on decrypt errors
            if (e.message && (e.message.includes('Bad MAC') || e.message.includes('SessionError') || e.message.includes('No matching sessions'))) {
                console.log('Ignored SessionError (WhatsApp LID bug):', e.message)
                return
            }
            console.error('messages.upsert error:', e.message)
        }
    })

    // Ignore all session errors globally
    sock.ev.on('creds.update', saveCreds)
}

startWhatsApp()

// Prevent whole process crash on unhandled SessionError
process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Bad MAC') || err.message.includes('SessionError'))) {
        console.log('Ignored uncaught SessionError:', err.message)
        return
    }
    console.error('Uncaught Exception:', err)
})
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason)
    if (msg.includes('Bad MAC') || msg.includes('SessionError') || msg.includes('No matching sessions')) {
        console.log('Ignored unhandled SessionError:', msg)
        return
    }
    console.error('Unhandled Rejection:', reason)
})

function getRealDate(aiDate) {
    const now = new Date()
    if (!aiDate || aiDate.toLowerCase() === 'today') return now.toISOString().split('T')[0]
    if (aiDate.toLowerCase() === 'tomorrow') { var t = new Date(); t.setDate(now.getDate() + 1); return t.toISOString().split('T')[0] }
    var days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"]
    if (days.includes(aiDate.toLowerCase())) {
        var target = days.indexOf(aiDate.toLowerCase())
        var diff = (target - now.getDay() + 7) % 7
        if (diff === 0) diff = 7
        var d = new Date(); d.setDate(now.getDate() + diff)
        return d.toISOString().split('T')[0]
    }
    return aiDate
}

var AI_PROMPT = 'You are Rideschat parser. Current: {TODAY_INFO} [{TODAY_DATE}]. Understand English, Telugu script, or transliterated Telugu. Translate to English JSON. Return JSON only: {"role":"rider|driver|command|greeting","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|RATING|null","takeId":number|null,"from":"string or null","to":"string or null","date":"YYYY-MM-DD or null","time":"HH:MM or null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":bool,"rating":number|null} Rules: If greeting like Hi/Hello set role greeting. tomorrow = {TOMORROW_DATE}. TAKE 1 -> command TAKE. Examples: Hi -> greeting, Need ride Denton to Dallas tmrw 5pm -> rider, Driver ON near UNT -> command ONLINE, TAKE 1 -> command TAKE takeId 1, 5 stars -> command RATING rating 5 Message: "{MSG}" JSON only.';

async function parseWithAI(msg) {
    var now = new Date(); var tomorrow = new Date(); tomorrow.setDate(now.getDate() + 1)
    var todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0]
    var prompt = AI_PROMPT.replaceAll("{TODAY_INFO}", todayInfo).replaceAll("{TODAY_DATE}", now.toISOString().split('T')[0]).replaceAll("{TOMORROW_DATE}", tomorrow.toISOString().split('T')[0]).replace("{MSG}", msg)
    var apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error("GEMINI_API_KEY missing")
    var models = ["gemini-2.0-flash", "gemini-1.5-flash"]
    for (var i=0;i<models.length;i++) {
        try {
            var url = "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent?key=" + apiKey
            var res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } })
            var cleanContent = res.data.candidates[0].content.parts[0].text.trim().replace(/^```(json)?/, '').replace(/```$/, '').trim()
            var data = JSON.parse(cleanContent)
            if (data.date) data.date = getRealDate(data.date)
            return data
        } catch (err) { if (i === models.length - 1) throw err }
    }
}

async function sendGupshupMessage(toPhone, messageText) {
    if (!toPhone ||!sock) return;
    try {
        let jid = toPhone.replace('@s.whatsapp.net', '').replace('+', '').replace('@lid','').trim();
        if(!jid.includes('@')) jid = jid + '@s.whatsapp.net'
        await sock.sendMessage(jid, { text: messageText })
        console.log('Sent to ' + toPhone)
    } catch (err) { console.error('Send error:', err.message) }
}

function formatRequests(reqs) {
    if (!reqs || reqs.length === 0) return "No active rides."
    return reqs.map(function(r){
        var girls = r.girls_only? ' GIRLS ONLY' : ''
        return r.id + ". " + r.from + "->" + r.to + " " + r.date + " " + (r.time || '') + " Bags:" + r.bags + girls + " wa.me/" + r.phone
    }).join('\n')
}
function formatOffers(offers) {
    if (!offers || offers.length === 0) return "No active offers."
    return offers.map(function(o,i){
        return (i+1) + ". " + o.from + "->" + o.to + " " + o.date + " " + (o.time || '') + " " + o.seats + "seats $" + o.price + " " + o.rating + " star wa.me/" + o.phone
    }).join('\n')
}

async function handleRideLogic(phone, text) {
    try {
        var user = await User.getOrCreate(phone)
        var ai = await parseWithAI(text)
        console.log("[" + phone + "] -> AI: " + JSON.stringify(ai))
        if (ai.role === 'greeting' || (!ai.from &&!ai.to && (!ai.command || ai.command === 'null' || ai.command === null))) {
