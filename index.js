require('dotenv').config()
const express = require('express')
const axios = require('axios')
const { sequelize, User, RideRequest, RideOffer } = require('./database')

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

sequelize.sync({ alter: true }).then(function(){ console.log("DB Synced") }).catch(function(e){ console.error("DB Sync error:", e.message) })

function getRealDate(aiDate) {
    const now = new Date()
    if (!aiDate || aiDate.toLowerCase() === 'today') return now.toISOString().split('T')[0]
    if (aiDate.toLowerCase() === 'tomorrow') {
        var t = new Date(); t.setDate(now.getDate() + 1); return t.toISOString().split('T')[0]
    }
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
    var models = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash"]
    for (var i=0;i<models.length;i++) {
        var modelName = models[i]
        try {
            console.log("Trying " + modelName)
            var url = "https://generativelanguage.googleapis.com/v1beta/models/" + modelName + ":generateContent?key=" + apiKey
            var res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } })
            var cleanContent = res.data.candidates[0].content.parts[0].text.trim()
            if (cleanContent.startsWith("```")) { cleanContent = cleanContent.replace(/^```(json)?/, '').replace(/```$/, '').trim() }
            var data = JSON.parse(cleanContent)
            if (data.date) data.date = getRealDate(data.date)
            console.log("Success with " + modelName)
            return data
        } catch (err) {
            console.log("Failed " + modelName + ": " + (err.response && err.response.data && err.response.data.error && err.response.data.error.message || err.message))
            if (i === models.length - 1) throw err
        }
    }
}

async function sendGupshupMessage(toPhone, messageText) {
    if (!toPhone) return;
    var cleanPhone = toPhone.replace('@s.whatsapp.net', '').replace('+', '').trim();
    var params = new URLSearchParams();
    params.append('channel', 'whatsapp');
    params.append('source', process.env.GUPSHUP_APP_NUMBER);
    params.append('destination', cleanPhone);
    params.append('src.name', process.env.GUPSHUP_APP_NAME);
    params.append('message', JSON.stringify({ type: 'text', text: messageText }));
    var apiKey = (process.env.GUPSHUP_API_KEY || process.env.GUPSHUP_APIKEY || '').trim();
    if (!apiKey) { console.error('GUPSHUP API Key missing!'); return; }
    try {
        var res = await axios.post('https://api.gupshup.io/sm/api/v1/msg', params.toString(), {
            headers: { 'apikey': apiKey, 'Authorization': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log('Gupshup sent OK: ' + (res.data && res.data.status || 'submitted'));
    } catch (err) { console.error('Gupshup send error:', err.response && err.response.data || err.message) }
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

function extractGupshupPayload(body) {
  if (!body) return null;
  try {
    if (body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
      var val = body.entry[0].changes[0].value;
      var msg = val.messages[0];
      var phone = msg.from || (val.contacts && val.contacts[0] && val.contacts[0].wa_id);
      var text = (msg.text && msg.text.body) || (msg.button && msg.button.text) || (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) || null;
      if (phone && text) return { phone: phone, text: text };
    }
  } catch (e) {}
  var payload = body.payload || body;
  var sender = payload.sender || body.sender;
  var text2 = null;
  if (payload.payload && payload.payload.text) text2 = payload.payload.text;
  else if (payload.text) text2 = payload.text;
  else if (typeof payload.body === 'string') text2 = payload.body;
  else if (body.text) text2 = body.text;
  var phone2 = sender && sender.phone || body.mobile || body.waNumber || body.from;
  if (!phone2 ||!text2) return null;
  return { phone: phone2, text: text2 };
}

app.post('/webhook', async function(req, res) {
    res.status(200).send('OK')
    console.log('WEBHOOK HIT: ' + JSON.stringify(req.body).substring(0, 800));
    var extracted = extractGupshupPayload(req.body);
    if (!extracted) return;
    var phone = extracted.phone; var text = extracted.text;
    try {
        var user = await User.getOrCreate(phone)
        var ai = await parseWithAI(text)
        console.log("[" + phone + "] Text: " + text + " -> AI: " + JSON.stringify(ai))

        if (ai.role === 'greeting' || (!ai.from &&!ai.to && (!ai.command || ai.command === 'null' || ai.command === null))) {
            await sendGupshupMessage(phone, "Welcome to Rideschat!\n\nSend like:\n- Need ride Denton to Dallas tomorrow 5pm\n- Driver ON near UNT\n- TAKE 1\n- 5 stars to rate")
            return
        }
        // FIXED BRACKET HERE
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
            try {
                var rideReq = await RideRequest.createCustom(phone, ai)
                console.log("Created ride: " + (rideReq && rideReq.id) + " " + (rideReq && rideReq.from) + "->" + (rideReq && rideReq.to))
                if (!rideReq ||!rideReq.from) throw new Error("create failed")
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
            } catch (dbErr) {
                console.error("RIDER DB ERROR: " + dbErr.message)
                await sendGupshupMessage(phone, "Got it! " + ai.from + " to " + ai.to + " on " + (ai.date || 'today') + " saved. Notifying drivers.")
            }
            return
        }

        if (ai.role === 'driver') {
            try {
                var offer = await RideOffer.createCustom(phone, ai)
                var riders = await RideRequest.getMatchingRiders(offer)
                if (riders.length > 0) {
                    await sendGupshupMessage(phone, "Rideschat: " + riders.length + " riders need " + offer.date + "!\n" + formatRequests(riders))
                } else {
                    await sendGupshupMessage(phone, "Offer posted: " + offer.from + "->" + offer.to + " " + offer.date + " " + (offer.time || ''))
                }
            } catch (dbErr) {
                console.error("DRIVER DB ERROR: " + dbErr.message)
                await sendGupshupMessage(phone, "Offer saved: " + ai.from + " to " + ai.to)
            }
        }
    } catch (err) { console.error('Error handling webhook:', err.stack || err.message) }
})

app.get('/ping', function(req, res){ res.send("Rideschat Alive") })
app.get('/', function(req, res){ res.send("Rideschat LIVE") })
var PORT = process.env.PORT || 10000
app.listen(PORT, function(){ console.log("Rideschat running on port " + PORT) })
