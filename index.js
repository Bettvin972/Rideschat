const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SOURCE = "254726705909";
const ADMIN = "13213668451";
const APP_NAME = "RidesChat";
let users = {};

// Helper function to send messages via Gupshup WhatsApp Cloud API
async function sendMsg(dest, txt) {
  const key = process.env.GUPSHUP_API_KEY;
  if (!key) {
    console.log("ERR: GUPSHUP_API_KEY environment variable is missing.");
    return;
  }

  const params = new URLSearchParams();
  params.append('channel', 'whatsapp');
  params.append('source', SOURCE);
  params.append('destination', dest);
  params.append('message', JSON.stringify({ type: "text", text: txt }));
  params.append('src.name', APP_NAME);

  try {
    let r = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
      method: 'POST',
      headers: {
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/x-www-form-urlencoded',
        'apikey': key,
        'app': APP_NAME
      },
      body: params
    });
    let resText = await r.text();
    console.log("Send Response:", resText);
  } catch (err) {
    console.log("Send Error:", err.message);
  }
}

app.post('/webhook', async (req, res) => {
  try {
    let body = req.body;
    console.log("HIT:", JSON.stringify(body).substring(0, 3000));

    let sender = "";
    let textRaw = "";

    if (body.entry && body.entry[0]?.changes?.[0]?.value?.messages?.[0]) {
      let m = body.entry[0].changes[0].value.messages[0];
      sender = m.from;
      textRaw = m.text?.body || "";
    }

    console.log(`Sender raw: ${sender} | Text raw: ${textRaw}`);
    if (!sender) return res.sendStatus(200);

    sender = String(sender).replace(/\D/g, '');
    let msg = String(textRaw).toLowerCase().trim();
    let u = users[sender] || { step: "start" };
    let reply = "";

    if (msg.includes("hi") || msg.includes("need") || msg === "") {
      users[sender] = { step: "start" };
      reply = "🚖 *DALLAS BOLT* - Desi Rides\n\n1️⃣ Book Ride\n2️⃣ My Rides\n3️⃣ Support +1 321 366 8451\n\nReply number.";
    } else if (msg === "1") {
      users[sender] = { step: "pickup" };
      reply = "Where pickup? Send address.";
    } else if (u.step === "pickup") {
      users[sender] = { step: "drop", pickup: textRaw };
      reply = "Drop where?";
    } else if (u.step === "drop") {
      users[sender] = { step: "lang", pickup: u.pickup, drop: textRaw };
      reply = "Language?\n1. English\n2. Only Telugu\nReply 1 or 2";
    } else if (u.step === "lang") {
      let lang = msg === "2" ? "Telugu/Broken" : "English";
      users[sender] = { step: "special", pickup: u.pickup, drop: u.drop, lang: lang };
      reply = "Any special?\n1. Girls Only\n2. Veg Only\n3. None\n4. Both\nReply 1-4";
    } else if (u.step === "special") {
      let sp = { "1": "Girls Only", "2": "Veg Only", "3": "None", "4": "Both" }[msg] || "None";
      reply = `✅ Ride Booked!\nPickup: ${u.pickup}\nDrop: ${u.drop}\nLang: ${u.lang}\nSpecial: ${sp}\n$25-35 Zelle 3213668451`;
      await sendMsg(ADMIN, `🚨 NEW RIDE: ${sender} From ${u.pickup} to ${u.drop}`);
      users[sender] = { step: "start" };
    } else {
      reply = "Reply HI to start";
    }

    await sendMsg(sender, reply);

  } catch (e) {
    console.log("ERR:", e.message);
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send("Dallas Bolt LIVE META FIXED"));
app.listen(process.env.PORT || 10000, () => console.log("Running"));

