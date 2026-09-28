const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SOURCE = "254726705909";
const ADMIN = "13213668451";
let users = {};

app.post('/webhook', async (req, res) => {
  try {
    // --- UNIVERSAL PARSER FOR V2 AND V3 ---
    let body = req.body;
    console.log("HIT:", JSON.stringify(body).substring(0, 1500));

    // v2: body is direct, v3 Meta: body.payload contains everything
    let p = body.payload || body;

    // SENDER - try all possible paths
    let sender =
        p.source ||
        p.sender?.phone ||
        p.payload?.source ||
        p.payload?.sender?.phone ||
        p.payload?.payload?.source ||
        p.payload?.payload?.sender?.phone ||
        body.source ||
        p.phone || "";

    // TEXT - try all possible paths for Meta v3
    let textRaw =
        p.payload?.payload?.text ||
        p.payload?.text ||
        p.payload?.payload?.payload?.text ||
        p.payload?.payload?.text ||
        p.text ||
        p.payload?.message?.text ||
        p.message || "";

    console.log(`Sender raw: ${sender} | Text raw: ${textRaw}`);

    if (!sender) return res.sendStatus(200);

    sender = String(sender).replace(/\D/g,'');
    let msg = String(textRaw).toLowerCase().trim();
    let u = users[sender] || {step:"start"};
    let reply = "";

    if (msg=="hi" || msg=="hello" || msg=="book" || msg=="hi there" || msg=="") {
      users[sender]={step:"start"};
      reply="🚖 *DALLAS BOLT* - Desi Rides\n\n1️⃣ Book Ride\n2️⃣ My Rides\n3️⃣ Support +1 321 366 8451\n\nReply number.\nCheap, Telugu/English, Girls safe, Veg driver.";
    } else if (msg=="1") {
      users[sender]={step:"pickup"};
      reply="Where pickup? Send address.\nEx: UTD, 10325 Audelia Rd";
    } else if (u.step=="pickup") {
      users[sender]={step:"drop", pickup:textRaw};
      reply="Drop where?";
    } else if (u.step=="drop") {
      users[sender]={step:"lang", pickup:u.pickup, drop:textRaw};
      reply="Language?\n1. English OK\n2. Only Telugu + Broken English\nReply 1 or 2";
    } else if (u.step=="lang") {
      let lang = msg=="2"?"Telugu/Broken":"English";
      users[sender]={step:"special", pickup:u.pickup, drop:u.drop, lang:lang};
      reply="Any special?\n1. Girls Only 👩\n2. Veg Only\n3. None\n4. Both Girls+Veg\nReply 1-4";
    } else if (u.step=="special") {
      let sp = {"1":"Girls Only","2":"Veg Only","3":"None","4":"Girls+Veg"}[msg] || "None";
      reply=`✅ Ride Booked!\n\n📍 Pickup: ${u.pickup}\n📍 Drop: ${u.drop}\n🗣️ ${u.lang}\n✨ ${sp}\n💰 $25-35\n💳 Zelle: 3213668451\nDriver will call in 5 mins. Q#${Math.floor(Math.random()*100)+1}`;
      let adminMsg=`🚨 NEW RIDE:\nPhone:${sender}\nFrom:${u.pickup} to ${u.drop}\nLang:${u.lang}\nSpecial:${sp}`;
      await sendMsg(ADMIN, adminMsg);
      users[sender]={step:"start"};
    } else {
      reply="Reply HI to start booking";
    }

    if (reply) {
      await sendMsg(sender, reply);
    }

  } catch(e){console.log("ERR:", e.message);}
  res.sendStatus(200);
});

async function sendMsg(dest, txt){
  try {
    const key = process.env.GUPSHUP_API_KEY;
    if (!key) { console.log("MISSING GUPSHUP_API_KEY!"); return; }
    const params = new URLSearchParams();
    params.append('channel','whatsapp');
    params.append('source', SOURCE);
    params.append('destination', dest);
    params.append('message', JSON.stringify({type:"text", text:txt}));
    params.append('src.name','RidesChat');

    let resp = await fetch('https://api.gupshup.io/sm/api/v1/msg',{
      method:'POST',
      headers:{'apikey':key, 'Content-Type':'application/x-www-form-urlencoded'},
      body:params
    });
    let data = await resp.text();
    console.log(`Send to ${dest}: ${data.substring(0,300)}`);
  } catch (err) {
    console.log("Send error:", err.message);
  }
}

app.get('/',(req,res)=>res.send("Dallas Bolt LIVE v3 FIXED"));
app.listen(process.env.PORT || 10000, ()=>console.log("Running"));
