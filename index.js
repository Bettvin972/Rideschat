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

function getNairobiNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
}

function getTimeGreeting() {
    const h = getNairobiNow().getHours();
    if (h >= 5 && h < 12) return "Good morning ☀️";
    if (h >= 12 && h < 15) return "Good afternoon 🌤️";
    if (h >= 15 && h < 19) return "Good evening 🌇";
    return "Sasa usiku 🌙";
}

function getRealDate(aiDate) {
    const now = getNairobiNow();
    if (!aiDate) return now.toISOString().split('T')[0];
    const str = aiDate.toString().toLowerCase();
    if (['today','now','null','asap','immediately','leo','sai','sahii','saa hii','now now'].includes(str)) return now.toISOString().split('T')[0];
    if (['tomorrow','kesho','kesho asubuhi'].includes(str)) { var t = new Date(now); t.setDate(now.getDate()+1); return t.toISOString().split('T')[0]; }
    var days = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
    if (days.includes(str)) {
        var target = days.indexOf(str);
        var diff = (target - now.getDay() + 7) % 7; if (diff===0) diff=7;
        var d = new Date(now); d.setDate(now.getDate()+diff); return d.toISOString().split('T')[0];
    }
    return aiDate;
}

function getRealTime(aiTime) {
    const now = getNairobiNow();
    const hhNow = String(now.getHours()).padStart(2,'0');
    const mmNow = String(now.getMinutes()).padStart(2,'0');
    if (!aiTime) return `${hhNow}:${mmNow}`;
    let lower = aiTime.toString().toLowerCase().trim();
    if (['now','asap','immediately','sasa','sai','sahii','saa hii','sasa hivi','now now','right now'].includes(lower)) return `${hhNow}:${mmNow}`;
    if (['kesho','tomorrow'].includes(lower)) return `09:00`;
    let m = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (m) {
        let h = parseInt(m[1]); let min = parseInt(m[2]||'0'); let ap = m[3];
        if (ap==='pm' && h<12) h+=12; if (ap==='am' && h===12) h=0;
        if (h>=0 && h<=23) return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    }
    return `${hhNow}:${mmNow}`;
}

function toDisplayTime(time24) {
    if (!time24 || time24==='Flexible') return 'now';
    let [h,m] = time24.split(':').map(Number);
    if (isNaN(h)) return time24;
    let ampm = h>=12?'PM':'AM';
    let hh = h%12||12;
    return `${hh}:${String(m||0).padStart(2,'0')} ${ampm}`;
}

function cleanContactNumber(jid) {
    if (!jid) return "Contact via Bot";
    let num = jid.split('@')[0].replace(/[^0-9]/g,'');
    if (num.length<9) return "Reply here - Bot will link you";
    if (num.startsWith('0')) num='254'+num.slice(1);
    if (!num.startsWith('254') && num.length===9) num='254'+num;
    return `https://wa.me/${num}`;
}

// ✅ NEW: Quick time parser for "Now" / "9" / "3pm" without AI
function parseTimeQuick(input) {
    if (!input) return null;
    let t = input.toLowerCase().trim();
    const now = getNairobiNow();
    if (['now','sai','sahii','saa hii','sasa','sasa hivi','now now','asap','immediately','saa hii','sai'].includes(t)) {
        return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    }
    if (t === 'kesho' || t === 'tomorrow') return '09:00';
    let m = t.match(/^(\d{1,2})(\s*(am|pm))?$/);
    if (m) {
        let h = parseInt(m[1]); let ap = m[3];
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2,'0')}:00`;
    }
    let m2 = t.match(/^(\d{1,2}):(\d{2})(\s*(am|pm))?$/);
    if (m2) {
        let h = parseInt(m2[1]); let min = parseInt(m2[2]); let ap = m2[4];
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
    }
    if (t.length <= 8) {
        let m3 = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
        if (m3) {
            let h = parseInt(m3[1]); let min = parseInt(m3[2] || '0'); let ap = m3[3];
            if (ap === 'pm' && h < 12) h += 12;
            if (ap === 'am' && h === 12) h = 0;
            return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
        }
    }
    return null;
}

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_PATH)) fs.mkdirSync(AUTH_PATH, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Starting WA v${version.join('.')}...`);
    sock = makeWASocket({
        version, auth: state, logger: pino({ level: 'silent' }),
        printQRInTerminal: false, browser: ["Rideschat","Chrome","1.0.0"],
        shouldSyncHistoryMessage: () => false, syncFullHistory: false, markOnlineOnConnect: false,
        getMessage: async () => undefined
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { qrLast = qr; console.log("NEW QR READY - Go to /qr"); }
        if (connection==='open') { console.log('WhatsApp Connected!'); qrLast=null; }
        if (connection==='close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Closed code:${statusCode}`);
            qrLast=null; sock=null;
            if (statusCode===DisconnectReason.loggedOut || statusCode===401) {
                if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH,{recursive:true,force:true});
            }
            setTimeout(startWhatsApp,5000);
        }
    });
    sock.ev.on('messages.upsert', async ({ messages }) => {
        try {
            if (!messages ||!messages[0]) return;
            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) return;
            const remoteJid = msg.key.remoteJid || "";
            if (remoteJid==='status@broadcast' || remoteJid.includes('@g.us')) return;
            if (msg.message.protocolMessage) return;

            let text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            if (msg.message.buttonsResponseMessage) {
                text = msg.message.buttonsResponseMessage.selectedButtonId || msg.message.buttonsResponseMessage.selectedDisplayText || "";
            }
            if (msg.message.templateButtonReplyMessage) {
                text = msg.message.templateButtonReplyMessage.selectedId || msg.message.templateButtonReplyMessage.selectedDisplayText || "";
            }
            if (!text) return;

            let realPhone = remoteJid;
            if (remoteJid.includes('@lid')) {
                if (msg.key.participant &&!msg.key.participant.includes('@lid')) realPhone = msg.key.participant;
                else if (msg.key.remoteJidAlt &&!msg.key.remoteJidAlt.includes('@lid')) realPhone = msg.key.remoteJidAlt;
            }
            console.log(`MSG [${remoteJid}] (${realPhone}): ${text}`);
            await handleRideLogic(remoteJid, text, realPhone);
        } catch (e) {
            const m = e.message||""; if (m.includes('Bad MAC')||m.includes('SessionError')) return;
            console.error('upsert error:',m);
        }
    });
}
startWhatsApp();

// ✅ UPDATED PROMPT with GREETING
var SYSTEM_PROMPT = `You are Rideschat Kenya assistant. Current: {TODAY_INFO} [{TODAY_DATE}] {GREETING}. Draft: {CONTEXT_DRAFT}
Sheng: niko=I am at, nataka kuenda/naenda=to, kutoka/from=from, sai/sahii/saa hii/now=now, kesho=tomorrow, leo=today, beba=ride.

Classify:
1. GREETING/CHITCHAT: "Hi","Hey","Mambo","Niaje","Good morning","How are you","Weather today","Will it rain?","Fare?","Safe?","Thanks","Asante","Cool"
-> {"role":"chat","reply":null}

2. RIDE: Extract JSON. "now" IS VALID TIME. "Niko juja city mall nataka kuenda thika" -> from=Juja City Mall,to=Thika,date=today,time=null. "Denton to Irving now" -> from=Denton,to=Irving,time=now.

3. COMMAND: "TAKE 1","TAKE_1","ONLINE","OFFLINE","FILTER Juja","CLEAR FILTERS","NEXT"

Return ONLY JSON:
{"role":"rider|driver|command|chat","command":"ONLINE|OFFLINE|SHOW_REQUESTS|TAKE|RATING|FILTER|CLEAR_FILTERS|NEXT|null","filter":string|null,"takeId":number|null,"from":string|null,"to":string|null,"date":"YYYY-MM-DD|today|tomorrow|null","time":"HH:MM|now|null","seats":number|null,"bags":number,"girls_only":bool,"pool_allowed":true,"rating":null,"reply":string|null}

Rules: Single location "Juja" -> from="Juja". If message has "now"/"sai", ALWAYS set time="now".
`;

async function parseWithAI(msg, contextDraft={}) {
    var now = getNairobiNow();
    var tomorrow = new Date(now); tomorrow.setDate(now.getDate()+1);
    var todayInfo = now.toLocaleDateString('en-US',{weekday:'long'})+" "+now.toISOString().split('T')[0]+" "+now.toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'});
    var greeting = getTimeGreeting();
    var systemPrompt = SYSTEM_PROMPT.replaceAll("{TODAY_INFO}",todayInfo).replaceAll("{TODAY_DATE}",now.toISOString().split('T')[0]).replaceAll("{GREETING}",greeting).replaceAll("{TOMORROW_DATE}",tomorrow.toISOString().split('T')[0]).replaceAll("{CONTEXT_DRAFT}",JSON.stringify(contextDraft));
    var apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY missing");
    var models = ["openai/gpt-oss-20b","openai/gpt-oss-120b","llama-3.3-70b-versatile"];
    for (var i=0;i<models.length;i++) {
        try {
            var res = await axios.post("https://api.groq.com/openai/v1/chat/completions",
                { model: models[i], messages: [{role:"system",content:systemPrompt},{role:"user",content:`Message: "${msg}"`}], temperature:0.2, response_format:{type:"json_object"} },
                { headers:{ "Authorization":`Bearer ${apiKey}`, "Content-Type":"application/json"} }
            );
            var data = JSON.parse(res.data.choices[0].message.content.trim());
            if (data.date) data.date=getRealDate(data.date);
            if (data.time) data.time=getRealTime(data.time);
            console.log(`Groq OK [${models[i]}]:`,data);
            return data;
        } catch(err) {
            console.warn(`Groq [${models[i]}] fail:`,err.response?.data?.error?.message||err.message);
            if (i===models.length-1) throw err;
        }
    }
}

// ✅ NEW SMART CHAT WITH REAL-TIME GREETING + WEATHER ETC
async function answerGeneralQuestion(question, userLocation="Juja") {
    try {
        const now = getNairobiNow();
        const timeStr = now.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', weekday:'long', hour:'2-digit', minute:'2-digit' });
        const greeting = getTimeGreeting();
        const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
            model: "openai/gpt-oss-20b",
            messages: [
                { role: "system", content: `You are Rideschat Kenya, friendly Sheng assistant. Current: ${timeStr} EAT (${greeting}), user location: ${userLocation}.
- Greeting: If user says Hi/Hey/Mambo: reply "${greeting}! Karibu Rideschat Kenya 🇰🇪" + brief help: "Just say 'Niko Juja nataka kuenda Thika sai'"
- Weather: If asks weather: Say "Today in ${userLocation}/Nairobi area is usually sunny 22-26°C, may rain afternoon. Best carry umbrella. Need ride to avoid rain?" You cannot fetch live weather, advise check Google Weather for live.
- Random chat: jokes, how are you, fare, safety: answer 2-3 lines friendly Sheng, then redirect: "Uko wapi? I can find you a ride."
- Never say "I'm not sure what you mean". Always help.
- Keep 2-4 lines max, use emojis sparingly.` },
                { role: "user", content: question }
            ],
            temperature: 0.8
        }, { headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` } });
        return res.data.choices[0].message.content.trim();
    } catch (e) {
        console.error("chat fail", e.message);
        return null;
    }
}

async function sendGupshupMessage(toJid, messageText) {
    if (!toJid||!sock) return;
    try {
        let jid = toJid.includes('@')?toJid:toJid.replace('+','').trim()+'@s.whatsapp.net';
        await sock.sendMessage(jid,{text:messageText});
    } catch(err){console.error('Send error:',err.message);}
}

async function sendRideButton(toJid, ride) {
    if (!toJid||!sock) return;
    try {
        let jid = toJid.includes('@')?toJid:toJid.replace('+','').trim()+'@s.whatsapp.net';
        let from = ride.from.split(',')[0].substring(0,18).trim();
        let to = ride.to.split(',')[0].substring(0,18).trim();
        let when = toDisplayTime(ride.time);
        let ppl = ride.people||ride.seats||1;
        let text = `📍 #${ride.id} ${from} → ${to}\n👥 ${ppl}p | ⏰ ${when} Today`;
        await sock.sendMessage(jid,{
            text:text,
            buttons:[
                {buttonId:`TAKE_${ride.id}`,buttonText:{displayText:`✅ TAKE #${ride.id}`},type:1}
            ],
            headerType:1
        });
    } catch(e){
        console.error('Button fail, fallback text:',e.message);
        await sendGupshupMessage(toJid,`• #${ride.id} ${ride.from} → ${ride.to} | ${toDisplayTime(ride.time)}\nTAKE ${ride.id}`);
    }
}

function formatRequests(reqs){
    if (!reqs||reqs.length===0) return "No active rides.";
    return reqs.slice(0,5).map(r=>`• #${r.id} ${r.from.split(',')[0].substring(0,14)} → ${r.to.split(',')[0].substring(0,14)} | ${toDisplayTime(r.time)}`).join('\n');
}

async function handleRideLogic(phoneJid, text, realPhone) {
    try {
        const lowerText = text.toLowerCase().trim();
        const userPhoneKey = realPhone||phoneJid;
        if (['okay','ok','cool','thx'].includes(lowerText)) return;

        if (lowerText.startsWith('filter ')) {
            let filterLoc = text.substring(7).trim();
            let u = await User.getOrCreate(userPhoneKey);
            u.filterFrom=filterLoc; await u.save();
            let nearby = await RideRequest.getNearby(filterLoc);
            if (nearby.length===0) {
                await sendGupshupMessage(phoneJid,`✅ Filter: ${filterLoc}\nNo rides now.`);
            } else {
                await sendGupshupMessage(phoneJid,`✅ Filter: ${filterLoc} | ${nearby.length} rides - Tap to TAKE:`);
                for (let r of nearby.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
            }
            return;
        }
        if (lowerText==='clear filters'||lowerText==='clear filter') {
            let u = await User.getOrCreate(userPhoneKey); u.filterFrom=null; await u.save();
            let nearby = await RideRequest.getNearby(u.location||'Juja');
            await sendGupshupMessage(phoneJid,`✅ Filters cleared - ${nearby.length} rides`);
            for (let r of nearby.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
            return;
        }

        const takeMatch = lowerText.match(/^take[_\s]*(\d+)$/i);
        var user = await User.getOrCreate(userPhoneKey);
        var session = getSession(userPhoneKey);

        // ✅ FIX FOR "Now" / "9" BUG - Handle time-only replies BEFORE AI
        if (session.draft.from && session.draft.to &&!session.draft.time) {
            let quickTime = parseTimeQuick(lowerText);
            if (quickTime) {
                console.log(`Quick time: ${lowerText} -> ${quickTime}`);
                session.draft.time = quickTime;
                session.draft.date = getRealDate('today');
                // Create ride directly
                var rideReq = await RideRequest.createCustom(userPhoneKey, session.draft);
                await sendGupshupMessage(phoneJid,`📝 RIDE #${rideReq.id} CREATED!\n📍 ${rideReq.from} → ${rideReq.to}\n⏰ ${toDisplayTime(rideReq.time)} Today\nAlerting drivers...`);
                var drivers = await User.getOnlineNearby(rideReq.from);
                var currentRiderClean = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
                var filteredDrivers = drivers.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==currentRiderClean;});
                for (var j=0;j<filteredDrivers.length;j++) { await sendRideButton(filteredDrivers[j].phone, rideReq); }
                clearSession(userPhoneKey); return;
            }
        }

        // Handle single location as TO
        if (session.draft.from &&!session.draft.to && lowerText.length >= 2 && lowerText.length <= 30 &&!lowerText.includes('need') &&!lowerText.includes('ride') &&!lowerText.includes('online')) {
            if (!parseTimeQuick(lowerText) && lowerText!== 'hi' && lowerText!== 'hey' && lowerText!== 'sasa') {
                session.draft.to = text.trim();
                session.draft.role = 'rider';
                await sendGupshupMessage(phoneJid,`⏰ WHAT TIME?\nReply: "Now" / "Sai" / "Kesho 9am" / "3 PM"`);
                return;
            }
        }

        var ai = await parseWithAI(text, session.draft);

        // ✅ SMART CHAT FOR RANDOM TEXTS + REAL-TIME GREETING
        if (ai.role==='chat') {
            // If we are in middle of booking, don't treat as random chat
            if (session.draft.from &&!session.draft.to) {
                // Still waiting for TO, let it continue
            } else {
                const userLoc = user.location || session.draft.from || "Juja";
                let smartReply = await answerGeneralQuestion(text, userLoc);
                if (!smartReply) {
                    smartReply = `${getTimeGreeting()}! Karibu Rideschat Kenya 🇰🇪\nJust say: 'Need ride FROM to TO at TIME'\nEg: 'Niko Juja nataka kuenda Thika sai'`;
                }
                await sendGupshupMessage(phoneJid, smartReply);
                return;
            }
        }

        let newFrom = ai.from||null; let newTo = ai.to||null;
        if (session.draft.from &&!session.draft.to && newFrom &&!newTo) { newTo=newFrom; newFrom=session.draft.from; }

        session.draft = {
            role: ai.role||session.draft.role||'rider',
            from: newFrom||session.draft.from||null,
            to: newTo||session.draft.to||null,
            date: ai.date||session.draft.date||null,
            time: ai.time||session.draft.time||null,
            bags: ai.bags??session.draft.bags??0,
            girls_only: ai.girls_only??session.draft.girls_only??false
        };

        if (takeMatch) { ai.role='command'; ai.command='TAKE'; ai.takeId=parseInt(takeMatch[1],10); }
        console.log("Merged Draft:",JSON.stringify(session.draft));

        if (ai.role==='command') {
            if (ai.command==='ONLINE') {
                await user.setOnline(ai.from||session.draft.from||"Juja",2);
                var nearby = await RideRequest.getNearby(user.location);
                if (nearby.length===0) {
                    await sendGupshupMessage(phoneJid,`🟢 ONLINE: ${user.location} | ⭐${user.rating.toFixed(1)}\nNo rides now. Stay ONLINE.\n${getTimeGreeting()}!`);
                } else {
                    await sendGupshupMessage(phoneJid,`🟢 ONLINE: ${user.location} | ⭐${user.rating.toFixed(1)}\n🔥 ${nearby.length} RIDES - Tap button to TAKE:`);
                    for (let r of nearby.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
                    if (nearby.length>5) await sendGupshupMessage(phoneJid,`+ ${nearby.length-5} more. Type NEXT\nFilter: FILTER Thika | CLEAR FILTERS`);
                }
            }
            if (ai.command==='OFFLINE') { await user.setOffline(); await sendGupshupMessage(phoneJid,`🔴 OFFLINE - ${getTimeGreeting()}!`); }
            if (ai.command==='SHOW_REQUESTS') {
                var nearby2 = await RideRequest.getNearby("Juja");
                if (nearby2.length===0) await sendGupshupMessage(phoneJid,`No rides in Juja - ${getTimeGreeting()}!`);
                else {
                    await sendGupshupMessage(phoneJid,`📋 ${nearby2.length} RIDES IN JUJA:`);
                    for (let r of nearby2.slice(0,5)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
                }
            }
            if (ai.command==='TAKE') {
                var ride = await RideRequest.findById(ai.takeId);
                if (ride && ride.status==='PENDING') {
                    await ride.updateStatus("TAKEN");
                    const riderContact = cleanContactNumber(ride.phone);
                    const driverContact = cleanContactNumber(userPhoneKey);
                    await sendGupshupMessage(phoneJid,`🎉 MATCHED #${ride.id}!\n📍 ${ride.from} → ${ride.to}\n⏰ ${toDisplayTime(ride.time)} Today\n\n👤 Rider: ${riderContact}\nCall now!`);
                    await sendGupshupMessage(ride.phone,`🚘 DRIVER FOUND!\nTrip ${ride.from} → ${ride.to} accepted.\n⭐ ${user.rating.toFixed(1)}\n📱 Driver: ${driverContact}\nDriver will call you`);
                } else {
                    await sendGupshupMessage(phoneJid,`❌ Ride #${ai.takeId} already taken.`);
                    var nearby3 = await RideRequest.getNearby(user.location);
                    for (let r of nearby3.slice(0,3)) { await sendRideButton(phoneJid,r); await new Promise(res=>setTimeout(res,400)); }
                }
            }
            return;
        }

        if (session.draft.role==='rider' && (!session.draft.from||!session.draft.to)) {
            if (!session.draft.from) await sendGupshupMessage(phoneJid,`📍 WHERE FROM?\nEg: "Juja"`);
            else await sendGupshupMessage(phoneJid,`📍 WHERE TO?\nYou are in *${session.draft.from}*, where to? Eg: "Thika"`);
            return;
        }
        if (session.draft.role==='rider' &&!session.draft.time) {
            await sendGupshupMessage(phoneJid,`⏰ WHAT TIME?\nReply: "Now" / "Sai" / "Kesho 9am" / "3 PM"`);
            return;
        }

        if (session.draft.role==='rider') {
            var rideReq2 = await RideRequest.createCustom(userPhoneKey, session.draft);
            var timeStrReq = toDisplayTime(rideReq2.time);
            await sendGupshupMessage(phoneJid,`📝 RIDE #${rideReq2.id} CREATED!\n📍 ${rideReq2.from} → ${rideReq2.to}\n⏰ ${timeStrReq} Today\nAlerting drivers...`);
            var drivers2 = await User.getOnlineNearby(rideReq2.from);
            var currentRiderClean2 = userPhoneKey.split('@')[0].replace(/[^0-9]/g,'');
            var filteredDrivers2 = drivers2.filter(d=>{var dc=(d.phone||'').split('@')[0].replace(/[^0-9]/g,''); return dc!==currentRiderClean2;});
            for (var j=0;j<filteredDrivers2.length;j++) { await sendRideButton(filteredDrivers2[j].phone, rideReq2); }
            clearSession(userPhoneKey); return;
        }
    } catch(err){ console.error('Error:',err.stack||err.message); }
}

setInterval(async()=>{ try{ if (RideRequest.clearExpired) await RideRequest.clearExpired(); if (RideOffer.clearExpired) await RideOffer.clearExpired(); }catch(e){console.error('[CRON]',e.message);} },15*60*1000);

app.get('/qr',(req,res)=>{ if (!qrLast) return res.send("<h1>Connected! Bot Live</h1>"); var qrImage="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data="+encodeURIComponent(qrLast); res.send("<h1>Scan Safaricom line</h1><p>WhatsApp > Linked Devices > Link</p><img src='"+qrImage+"'/>"); });
app.get('/ping',(req,res)=>{ res.send("Rideschat Kenya Alive"); });
app.get('/',(req,res)=>{ res.send("Rideschat Kenya LIVE - Go to /qr"); });
var PORT = process.env.PORT||10000;
app.listen(PORT,()=>{ console.log("Rideschat Kenya running on port "+PORT); });
