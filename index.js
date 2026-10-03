const express = require('express')
const axios = require('axios')
const { OpenAI } = require('openai')
const { User, RideRequest, RideOffer } = require('./database')

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY || "YOUR_OPENAI_KEY_HERE" })
const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Helper function to convert dynamic dates into standard YYYY-MM-DD
function getRealDate(aiDate) {
    const now = new Date()
    if (!aiDate || aiDate.toLowerCase() === 'today') return now.toISOString().split('T')[0]
    if (aiDate.toLowerCase() === 'tomorrow') { 
        const t = new Date()
        t.setDate(now.getDate() + 1)
        return t.toISOString().split('T')[0] 
    }
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    if (days.includes(aiDate.toLowerCase())) {
        let target = days.indexOf(aiDate.toLowerCase())
        let diff = (target - now.getDay() + 7) % 7
        if (diff === 0) diff = 7
        const d = new Date()
        d.setDate(now.getDate() + diff)
        return d.toISOString().split('T')[0]
    }
    return aiDate
}

const AI_PROMPT = `
You are DALLAS BOLT parser. Current: {TODAY_INFO} [{TODAY_DATE}].
Understand user messages in English, Telugu script, or transliterated Telugu (Telish). Always translate location names, days, and intents into English JSON output.

Return JSON only: {"role":"rider|driver|command","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|RATING|null","takeId":number|null,"from":"string or null","to":"string or null","date":"YYYY-MM-DD or null","time":"HH:MM or null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":bool,"rating":number|null}

Rules: tomorrow = {TOMORROW_DATE}. girls only if says girls only/ladies only/అమ్మాయిలు మాత్రమే. TAKE 1/TAKE 2 -> command TAKE.
Examples: 
- "Need ride Denton to Dallas tmrw 5pm" -> rider
- "రేపు సాయంత్రం 5 గంటలకి డెంటన్ నుండి డల్లాస్ కి రైడ్ కావాలి" -> rider (from: "Denton", to: "Dallas")
- "Denton nundi Dallas ki ride kavali tmrw 5pm" -> rider
- "Driver ON near UNT" -> command ONLINE
- "TAKE 1" -> command TAKE takeId 1
- "5 stars" -> command RATING rating 5

Message: "{MSG}"
JSON only.
`;

async function parseWithAI(msg) {
    const now = new Date()
    const tomorrow = new Date()
    tomorrow.setDate(now.getDate() + 1)
    const todayInfo = now.toLocaleDateString('en-US', { weekday: 'long' }) + " " + now.toISOString().split('T')[0]
    
    const prompt = AI_PROMPT
        .replaceAll("{TODAY_INFO}", todayInfo)
        .replaceAll("{TODAY_DATE}", now.toISOString().split('T')[0])
        .replaceAll("{TOMORROW_DATE}", tomorrow.toISOString().split('T')[0])
        .replace("{MSG}", msg)

    const res = await openai.chat.completions.create({ 
        model: "gpt-4o-mini", 
        messages: [{ role: "user", content: prompt }], 
        temperature: 0 
    })

    let cleanContent = res.choices[0].message.content.trim()
    if (cleanContent.startsWith("```")) {
        cleanContent = cleanContent.replace(/^```(json)?/, '').replace(/```$/, '').trim()
    }

    let data = JSON.parse(cleanContent)
    if (data.date) data.date = getRealDate(data.date)
    return data
}

// Outbound Messaging Helper using Gupshup REST API
async function sendGupshupMessage(toPhone, messageText) {
    if (!toPhone) return;
    const cleanPhone = toPhone.replace('@s.whatsapp.net', '').replace('+', '').trim()
    
    const params = new URLSearchParams({
        channel: 'whatsapp',
        source: process.env.GUPSHUP_APP_NUMBER,
        destination: cleanPhone,
        'src.name': process.env.GUPSHUP_APP_NAME,
        message: JSON.stringify({ type: 'text', text: messageText })
    })

    try {
        await axios.post('[https://api.gupshup.io/sm/api/v1/msg](https://api.gupshup.io/sm/api/v1/msg)', params, {
            headers: {
                'apikey': process.env.GUPSHUP_API_KEY,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        })
    } catch (err) {
        console.error('Gupshup send error:', err.response?.data || err.message)
    }
}

// Formatting helpers
function formatRequests(reqs) {
    if (!reqs || reqs.length === 0) return "No active rides."
    return reqs.map(r => `${r.id}. ${r.from}->${r.to} ${r.date} ${r.time || ''} Bags:${r.bags} ${r.girls_only ? 'GIRLS ONLY' : ''} wa.me/${r.phone}`).join('\n')
}

function formatOffers(offers) {
    if (!offers || offers.length === 0) return "No active offers."
    return offers.map((o, i) => `${i + 1}. ${o.from}->${o.to} ${o.date} ${o.time || ''} ${o.seats}seats $${o.price} ${o.rating}⭐ wa.me/${o.phone}`).join('\n')
}

// Robust Payload Extraction for Gupshup Inbound Messages
function extractGupshupPayload(body) {
    if (!body) return null;
    
    const payload = body.payload || body;
    const sender = payload.sender || body.sender;
    
    let text = null;
    if (payload.payload && payload.payload.text) {
        text = payload.payload.text;
    } else if (payload.text) {
        text = payload.text;
    } else if (typeof payload.body === 'string') {
        text = payload.body;
    }

    const phone = sender?.phone || body.mobile || body.waNumber;

    if (!phone || !text) return null;
    return { phone, text };
}

// ==========================================
// GUPSHUP WEBHOOK ENDPOINT
// ==========================================
app.post('/webhook', async (req, res) => {
    // Immediately respond to acknowledge receipt to Gupshup
    res.status(200).send('OK')

    const extracted = extractGupshupPayload(req.body);
    if (!extracted) return;

    const { phone, text } = extracted;

    try {
        const user = await User.getOrCreate(phone)
        const ai = await parseWithAI(text)
        console.log(`[${phone}] Text: "${text}" -> AI Output:`, ai)

        // DRIVER COMMANDS
        if (ai.role === 'command') {
            if (ai.command === 'ONLINE') {
                await user.setOnline(ai.from || "Denton", 2)
                const nearby = await RideRequest.getNearby(user.location)
                await sendGupshupMessage(
                    phone, 
                    `✅ ONLINE 2hrs near ${user.location} on ${ai.date || 'today'}\nRating: ${user.rating.toFixed(1)}⭐\n${formatRequests(nearby)}\nType TAKE <id> to claim`
                )
            }
            if (ai.command === 'OFFLINE') {
                await user.setOffline()
                await sendGupshupMessage(phone, "OFFLINE. No more pings.")
            }
            if (ai.command === 'SHOW_REQUESTS') {
                const nearby = await RideRequest.getNearby("Denton")
                await sendGupshupMessage(phone, formatRequests(nearby))
            }
            if (ai.command === 'TAKE') {
                const req = await RideRequest.findById(ai.takeId)
                if (req) {
                    await req.updateStatus("TAKEN")
                    await sendGupshupMessage(
                        phone, 
                        `You claimed ride ${req.id}. Rider wa.me/${req.phone}\nAfter ride, ask rider to rate: '5 stars'`
                    )
                    await sendGupshupMessage(
                        req.phone, 
                        `Driver on way! ${user.phone} ${user.rating.toFixed(1)}⭐ wa.me/${phone}`
                    )
                } else {
                    await sendGupshupMessage(phone, `Ride ID ${ai.takeId} not found or already taken.`)
                }
            }
            if (ai.command === 'RATING') {
                await user.addRating(ai.rating)
                await sendGupshupMessage(phone, `Thanks! Rated ${ai.rating}⭐`)
            }
            return
        }

        // RIDER REQUESTS
        if (ai.role === 'rider') {
            const req = await RideRequest.create(phone, ai)
            const matches = await RideOffer.perfectMatch(req)
            if (matches.length > 0) {
                await sendGupshupMessage(
                    phone, 
                    `✅ Found ${matches.length} for ${req.date} ${req.time || ''}\n${formatOffers(matches)}\nReply 1 to connect`
                )
            } else {
                await sendGupshupMessage(
                    phone, 
                    `⏳ No exact match for ${req.date} ${req.time || ''}. Queued.\nWill notify + ping ONLINE drivers.`
                )
                
                // Immediately ping online drivers nearby
                const drivers = await User.getOnlineNearby(req.from || "Denton")
                for (let d of drivers) {
                    await sendGupshupMessage(
                        d.phone, 
                        `🔔 Near you! ${req.from}->${req.to} ${req.date} ${req.time || ''} Bags:${req.bags} ${req.girls_only ? 'GIRLS ONLY' : ''}\nTAKE ${req.id}`
                    )
                }
            }
            return
        }

        // DRIVER OFFERS
        if (ai.role === 'driver') {
            const offer = await RideOffer.create(phone, ai)
            const riders = await RideRequest.getMatchingRiders(offer)
            if (riders.length > 0) {
                await sendGupshupMessage(
                    phone, 
                    `🔥 ${riders.length} riders need ${offer.date}!\n${formatRequests(riders)}`
                )
            } else {
                await sendGupshupMessage(
                    phone, 
                    `Offer posted: ${offer.from}->${offer.to} ${offer.date} ${offer.time || ''} ${offer.seats} seats $${offer.price} (${offer.rating}⭐)`
                )
            }
        }
    } catch (err) {
        console.error('Error handling webhook payload:', err)
    }
})

// Health check endpoint
app.get('/ping', (req, res) => res.send("Bolt Alive"))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Bolt App running on port ${PORT}`))
