// === WhatsApp + OpenAI AI Sales Bot (ESM) ===
// Çalışma: Railway / Node 18+
// Env: OPENAI_API_KEY, (opsiyonel) STORE_NAME, BOT_DEFAULT_LANG
// Komutlar: "operator" -> botu sustur, "bot" -> tekrar aç

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- WhatsApp Client ----------
const client = new Client({
  authStrategy: new LocalAuth(), // session/ klasöründe oturum saklar
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

// ---------- OpenAI ----------
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Basit hafıza ----------
const sessions = new Map(); // chatId -> { history:[{role,content}], muted:boolean }

function bootstrap(chatId) {
  if (!sessions.has(chatId)) {
    const store = process.env.STORE_NAME || 'Pellvero';
    const systemPrompt = `
You are a WhatsApp sales assistant for the Romanian online store "${store}".
- Detect the user's language. If Romanian, answer in Romanian. If Turkish, answer in Romanian and add a concise Turkish translation on a new line starting with "TR:".
- Your goal is to complete COD (plată la livrare) orders.
- If user wants to order, ask in order: full name, full address (street, number, apartment, postal code), phone number, shoe size, color.
- When enough info is gathered, show a clean order summary and ask for "DA" to confirm or "MODIFIC" to change.
- Delivery: 7–10 zile lucrătoare.
- Prices: 1 pereche 179,90 LEI; 2 perechi 279,90 LEI. Transport gratuit, plata la livrare.
- Be short (max 5 short lines), polite, human-like.
`.trim();

    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPrompt }],
    });
  }
  return sessions.get(chatId);
}

async function askAI(chatId, text) {
  const sess = bootstrap(chatId);
  // hafızayı şişirmemek için kısalt
  if (sess.history.length > 24) {
    sess.history = [sess.history[0], ...sess.history.slice(-12)];
  }
  sess.history.push({ role: 'user', content: text });

  const res = await ai.chat.completions.create({
    model: 'gpt-4o-mini',     // istersen gpt-3.5-turbo da kullanabilirsin
    temperature: 0.3,
    messages: sess.history,
  });

  const reply = res.choices?.[0]?.message?.content?.trim() || '';
  sess.history.push({ role: 'assistant', content: reply });
  return reply;
}

// ---------- WhatsApp Events ----------
client.on('qr', (qr) => {
  // Railway Logs içinde ASCII QR görünecek
  qrcode.generate(qr, { small: true });
  console.log('🔑 QR çıktı. WhatsApp > Bağlı Cihazlar > Cihaz Bağla ile tara.');
});

client.on('ready', () => {
  console.log('✅ WhatsApp bot hazır.');
});

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return; // kendi mesajına dönmesin
    const chatId = msg.from;
    const text = (msg.body || '').trim();
    console.log(`📩 ${chatId}: ${text}`);

    const sess = bootstrap(chatId);

    // Operatör devre dışı / aktif komutları
    const lower = text.toLowerCase();
    if (lower === 'operator') {
      sess.muted = true;
      await msg.reply('Vă conectăm cu un operator. Mulțumim!');
      return;
    }
    if (lower === 'bot') {
      sess.muted = false;
      await msg.reply('Asistentul a fost reactivat. Cum vă pot ajuta?');
      return;
    }
    if (sess.muted) return;

    // AI cevabı
    const reply = await askAI(chatId, text);
    if (reply) await msg.reply(reply);
  } catch (err) {
    console.error('❌ Hata:', err);
    try {
      await msg.reply('Ne pare rău, a apărut o eroare temporară. Încercați din nou.');
    } catch {}
  }
});

// ---------- Keepalive (Railway) ----------
app.get('/', (_req, res) => res.send('WhatsApp AI bot aktiv ✅'));
app.listen(PORT, () => console.log(`HTTP portu: ${PORT}`));

client.initialize();
