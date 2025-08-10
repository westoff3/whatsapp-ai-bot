// === WhatsApp + OpenAI AI Sales Bot (ESM) ===
// Çalışma Ortamı: Railway / Node 18+
// Gerekli ENV: OPENAI_API_KEY, REDIS_URL
// Opsiyonel ENV: STORE_NAME, BOT_DEFAULT_LANG
// Komutlar: "operator" -> botu sustur, "bot" -> tekrar aç

import pkg from 'whatsapp-web.js';
const { Client, RemoteAuth } = pkg;
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';
import QRCode from 'qrcode';
import { RedisStore } from 'wwebjs-redis';
import { createClient } from 'redis';

// --- Redis Ayarı ---
const redisClient = createClient({ url: process.env.REDIS_URL });
await redisClient.connect();
const store = new RedisStore({ client: redisClient });

// --- Global ---
let lastQr = null;
const sessions = new Map();
const PORT = process.env.PORT || 3000;

// --- WhatsApp Client ---
const client = new Client({
  authStrategy: new RemoteAuth({
    store: store,
    backupSyncIntervalMs: 300000 // 5dk
  }),
  puppeteer: {
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROME_PATH ||
      '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

// --- OpenAI ---
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- SSS Şablonları ---
const faqMap = {
  'fiyat': 'Prețurile noastre: 1 pereche 179,90 LEI, 2 perechi 279,90 LEI. Transport gratuit.',
  'iade': 'Aveți drept de retur în 14 zile. Produsele trebuie returnate neutilizate.',
  'teslim': 'Livrarea durează 7–10 zile lucrătoare.',
  'iban': 'Plata la livrare, nu este necesar transfer bancar.',
};

// --- Session Başlatma ---
function bootstrap(chatId) {
  if (!sessions.has(chatId)) {
    const storeName = process.env.STORE_NAME || 'Pellvero';
    const systemPrompt = `
Ești un asistent de vânzări pe WhatsApp pentru magazinul online românesc "${storeName}".
Răspunde ÎNTOTDEAUNA doar în limba română. Nu adăuga traduceri și nu folosi altă limbă.
Scopul tău este să finalizezi comenzi cu plată la livrare (COD).
Dacă utilizatorul vrea să comande, cere pe rând:
1) Numele complet
2) Adresa completă (stradă, număr, apartament, cod poștal)
3) Mărimea încălțămintei
4) Culoarea dorită
Numărul de telefon NU se solicită — îl obținem automat din WhatsApp.
Când ai suficiente informații, adaugă numărul de telefon obținut automat și trimite un rezumat clar, apoi cere confirmarea cu „DA” sau „MODIFIC”.
Livrare: 7–10 zile lucrătoare.
Prețuri: 1 pereche 179,90 LEI; 2 perechi 279,90 LEI. Transport gratuit, plată la livrare.
Răspunde scurt (max 5 rânduri), politicos și natural.
`.trim();

    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPrompt }]
    });
  }
  return sessions.get(chatId);
}

// --- AI Sorgulama ---
async function askAI(chatId, text) {
  const sess = bootstrap(chatId);

  if (sess.history.length > 24) {
    sess.history = [sess.history[0], ...sess.history.slice(-12)];
  }

  sess.history.push({ role: 'user', content: text });

  const res = await ai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    messages: sess.history
  });

  const reply = res.choices?.[0]?.message?.content?.trim() || '';
  sess.history.push({ role: 'assistant', content: reply });
  return reply;
}

// --- WhatsApp Eventleri ---
client.on('qr', (qr) => {
  lastQr = qr;
  qrcode.generate(qr, { small: true });
  console.log('🔑 QR hazır. WhatsApp > Bağlı Cihazlar > Cihaz Bağla ile tara.');
});

client.on('ready', () => {
  console.log('✅ WhatsApp bot hazır.');
});

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const text = (msg.body || '').trim();
    const lower = text.toLowerCase();

    // --- Bot kontrol komutları ---
    const sess = bootstrap(chatId);
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

    // --- Site sorusu ---
    if (lower.includes('site') || lower.includes('website') || lower.includes('link')) {
      await msg.reply('Site-ul nostru: https://pellvero.com/');
      return;
    }

    // --- SSS cevapları ---
    for (const key in faqMap) {
      if (lower.includes(key)) {
        await msg.reply(faqMap[key]);
        return;
      }
    }

    // --- AI cevabı ---
    const phoneFromWp = chatId.split('@')[0]; // WhatsApp'tan tel no
    const injectedText = `${text}\n(Număr WhatsApp: ${phoneFromWp})`; // AI'ye ek bilgi

    const reply = await askAI(chatId, injectedText);
    if (reply) await msg.reply(reply);
  } catch (err) {
    console.error('❌ Hata:', err);
    try {
      await msg.reply('Ne pare rău, a apărut o eroare temporară. Încercați din nou.');
    } catch {}
  }
});

// --- Express Keepalive ---
const app = express();

app.get('/qr', async (_req, res) => {
  try {
    if (!lastQr) return res.status(404).send('QR hazır değil.');
    res.setHeader('Content-Type', 'image/png');
    const png = await QRCode.toBuffer(lastQr, { width: 360, margin: 1 });
    res.end(png);
  } catch (e) {
    res.status(500).send('QR oluşturulamadı.');
  }
});

app.get('/', (_req, res) => res.send('WhatsApp AI bot aktiv ✅'));

app.listen(PORT, () => console.log(`HTTP portu: ${PORT}`));

// --- Bot Başlat ---
client.initialize();
