require('dotenv').config()
const express = require('express')
const axios = require('axios')
const { sequelize, User, RideRequest, RideOffer } = require('./database')

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

sequelize.sync({ alter: true }).then(() => console.log("✅ DB Synced")).catch(e => console.error("DB Sync error:", e.message))

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
You are Rideschat parser. Current: {TODAY_INFO} [{TODAY_DATE}].
Understand user messages in English, Telugu script, or transliterated Telugu (Telish). Always translate location names, days, and intents into English JSON output.
Return JSON only: {"role":"rider|driver|command|greeting","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|RATING|null","takeId":number|null,"from":"string or null","to":"string or null","date":"YYYY-MM-DD or null","time":"HH:MM or null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":bool,"rating":number|null}
Rules:
- If the message is a greeting like "Hi", "Hello", "Hey", or lacks any ride/driver details, set "role": "greeting".
- tomorrow = {TOMORROW_DATE}. girls only if says girls only/ladies only/అమ్మాయిలు మాత్రమే. TAKE 1/TAKE 2 -> command TAKE.
Examples:
- "Hi" -> greeting
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
    const prompt = AI_PROMPT.replaceAll("{TODAY_INFO}", todayInfo).replaceAll("{TODAY_DATE}", now.toISOString().split('T')[0]).replaceAll("{TOMORROW_DATE}", tomorrow.toISOString().split('T')[0]).replace("{MSG}", msg)
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error("GEMINI_API_KEY missing")
    const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash"]
    for (let modelName of models) {
        try {
            console.log(`Trying ${modelName}`)
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`
            const res = await axios.post(url, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0 }
            })
            let cleanContent = res.data.candidates[0].content.parts[0].text.trim()
            if (cleanContent.startsWith("```")) { cleanContent = cleanContent.replace(/^```(json)?/, '').replace(/```$/, '').trim() }
            let data = JSON.parse(cleanContent)
            if (data.date) data.date = getRealDate(data.date)
            console.log(`Success with ${modelName}`)
            return data
        } catch (err) {
            console.log(`Failed ${modelName}: ${err.response?.data?.error?.message || err.message}`)
            if (modelName === models[models.length - 1]) throw err
        }
    }
}

async function sendGupshupMessage(toPhone, messageText) {
    if (!toPhone) return;
    const cleanPhone = toPhone.replace('@s.whatsapp.net', '').replace('+', '').trim();
    const params = new URLSearchParams();
    params.append('channel', 'whatsapp');
    params.append('source', process.env.GUPSHUP_APP_NUMBER);
    params.append('destination', cleanPhone);
    params.append('src.name', process.env.GUPSHUP_APP_NAME);
    params.append('message', JSON.stringify({ type: 'text', text: messageText }));
    const apiKey = (process.env.GUPSHUP_API_KEY || process.env.GUPSHUP_APIKEY || '').trim();
    if (!apiKey) { console.error('GUPSHUP API Key missing!'); return; }
    try {
        const res = await axios.post('https://api.gupshup.io/sm/api/v1/msg', params.toString(), {
            headers: { 'apikey': apiKey, 'Authorization': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log('Gupshup sent OK:', res.data?.status || 'submitted');
    } catch (err) { console.error('Gupshup send error:', err.response?.data || err.message) }
}

function formatRequests(reqs) {
    if (!reqs || reqs.length === 0) return "No active rides."
    return reqs.map(r => `${r.id}. ${r.from
