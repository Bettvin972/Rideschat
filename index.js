require('dotenv').config()
const express = require('express')
const axios = require('axios')
const fs = require('fs')
const { sequelize, User, RideRequest, RideOffer } = require('./database')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode-terminal')

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

sequelize.sync({ alter: true }).then(function(){ console.log("DB Synced") }).catch(function(e){ console.error("DB Sync error:", e.message) })

let sock = null
let qrLast = null

async function startWhatsApp() {
    if(!fs.existsSync('auth_info')) fs.mkdirSync('auth_info')
    const { state, saveCreds } = await useMultiFileAuthState('auth_info')
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["Rideschat", "Chrome", "1.0"]
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
            if(shouldReconnect) setTimeout(startWhatsApp, 3000)
        }
    })
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0]
        if(!msg.message || msg.key.fromMe) return
        const phone = msg.key.remoteJid.replace('@s.whatsapp.net','').replace('@c.us','')
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ""
        if(!text) return
        console.log(`MSG [${phone}]: ${text}`)
        handleRideLogic(phone.trim(), text)
    })
}
startWhatsApp()

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

// SAME NAME SO YOU DON'T CHANGE OTHER CODE - BUT NOW USES BAILEYS
async function sendGupshupMessage(toPhone, messageText) {
    if (!toPhone ||!sock) return;
    try {
        let jid = toPhone.replace('@s.whatsapp.net', '').replace('+', '').trim();
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
            await sendGupshupMessage(phone, "Welcome to Rideschat!\n\nSend like:\n- Need ride Denton to Dallas tomorrow 5pm\n- Driver ON near UNT\n- TAKE 1\n- 5 stars to rate")
            return
        }
        if (ai.role === 'rider' && (!ai.from ||!ai.to)) {
            await sendGupshupMessage(phone, "Where to where? Send like: Need ride Denton to Dallas tomorrow 5pm")
            return
        }
        if (ai.role === 'command') {
            if (ai.command === 'ONLINE') {
                await user.setOnline(ai.from || "Denton", 2)
                var nearby = await RideRequest.getNearby(user.location)
                await sendGupshupMessage(phone, "Rideschat: ONLINE 2hrs near " + user.location + " on " + (ai.date || 'today') + "\nRating: " + user.rating.toFixed(1) + " star\n" + formatRequests(nearby) + "\nType TAKE <id> to claim")
            }
            if (ai.command === 'OFFLINE') { await user.setOffline(); await sendGupshupMessage(phone, "Rideschat: OFFLINE. No more pings.") }
            if (ai.command === 'SHOW_REQUESTS') { var nearby2 = await RideRequest.getNearby("Denton"); await sendGupshupMessage(phone, formatRequests(nearby2)) }
            if (ai.command === 'TAKE') {
                var ride = await RideRequest.findById(ai.takeId)
                if (ride) {
                    await ride.updateStatus("TAKEN")
                    await sendGupshupMessage(phone, "You claimed ride " + ride.id + ". Rider wa.me/" + ride.phone)
                    await sendGupshupMessage(ride.phone, "Driver on way! " + user.phone + " " + user.rating.toFixed(1) + " star wa.me/" + phone)
                } else { await sendGupshupMessage(phone, "Ride ID " + ai.takeId + " not found") }
            }
            if (ai.command === 'RATING') { await user.addRating(ai.rating); await sendGupshupMessage(phone, "Thanks! Rated " + ai.rating + " star") }
            return
        }
        if (ai.role === 'rider') {
            var rideReq = await RideRequest.createCustom(phone, ai)
            var matches = await RideOffer.perfectMatch(rideReq)
            if (matches && matches.length > 0) {
                await sendGupshupMessage(phone, "Rideschat: Found " + matches.length + " for " + rideReq.date + " " + (rideReq.time || '') + "\n" + formatOffers(matches))
            } else {
                await sendGupshupMessage(phone, "Rideschat: No exact match for " + rideReq.date + " " + (rideReq.time || '') + ". Queued. Will notify drivers.")
                var drivers = await User.getOnlineNearby(rideReq.from)
                for (var j=0;j<drivers.length;j++) {
                    await sendGupshupMessage(drivers[j].phone, "Near you! " + rideReq.from + "->" + rideReq.to + " " + rideReq.date + " Bags:" + rideReq.bags + " TAKE " + rideReq.id)
                }
            }
            return
        }
        if (ai.role === 'driver') {
            var offer = await RideOffer.createCustom(phone, ai)
            var riders = await RideRequest.getMatchingRiders(offer)
            if (riders.length > 0) {
                await sendGupshupMessage(phone, "Rideschat: " + riders.length + " riders need " + offer.date + "!\n" + formatRequests(riders))
            } else {
                await sendGupshupMessage(phone, "Offer posted: " + offer.from + "->" + offer.to + " " + offer.date + " " + (offer.time || ''))
            }
        }
    } catch (err) { console.error('Error:', err.stack || err.message) }
}

// Routes
app.get('/qr', function(req, res){
    if(!qrLast) return res.send("<h1 style='font-family:sans-serif'>✅ Connected or waiting... check / logs</h1>")
    var qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qrLast)
    res.send("<h1>Scan with Safaricom line</h1><p>WhatsApp > Linked Devices > Link a Device</p><img src='"+qrImage+"'/><p>Refresh after 20 sec</p>")
})
app.post('/webhook', function(req,res){ res.send('OK') }) // not needed anymore
app.get('/ping', function(req, res){ res.send("Rideschat Alive") })
app.get('/', function(req, res){ res.send("Rideschat LIVE - Baileys Mode. Go to /qr") })
var PORT = process.env.PORT || 10000
app.listen(PORT, function(){ console.log("Rideschat running on port " + PORT) })
