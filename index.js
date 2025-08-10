// === WhatsApp + OpenAI AI Sales Bot (ESM - AI ONLY) ===
// Çalışma Ortamı: Railway / Node 18+
// ENV: OPENAI_API_KEY
// Opsiyonel ENV: STORE_NAME

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';
import QRCode from 'qrcode';

// --- Global ---
let lastQr = null;
const sessions = new Map(); // chatId -> { muted, history }
const PORT = process.env.PORT || 3000;

// --- WhatsApp Client ---
const client = new Client({
  authStrategy: new LocalAuth(), // dosyaya kaydeder; restartta QR istemez
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

// --- Hızlı SSS (TR tetik / RO yanıt) ---
const faqMap = [
  { keys: ['fiyat','ucret','ücret','price','preț'], reply: 'Prețuri: 1 pereche 179,90 LEI; 2 perechi 279,90 LEI. Transport gratuit, plată la livrare.' },
  { keys: ['iade','geri','return','retur'],       reply: 'Retur în 14 zile calendaristice. Produs neutilizat și ambalaj intact.' },
  { keys: ['teslim','kargo','ne zaman','kaç günde','zaman','livrare','cât durează'], reply: 'Livrarea durează 7–10 zile lucrătoare. Transport gratuit.' },
  { keys: ['iban','havale','eft','banka','transfer'], reply: 'Plata la livrare (COD). Transfer bancar nu este necesar.' },
  { keys: ['site','website','link','adres'],       reply: 'Site-ul nostru: https://pellvero.com/' },
];

// --- küçük yardımcı: sohbet içinden telefon yakala ---
function pickPhone(text) {
  const digits = (text || '').replace(/\D+/g, '');
  // Romanya: +40/40/07 ile başlayan tipikler
  // örn: +40722xxxxxx, 0722xxxxxx, 40722xxxxxx
  const m =
    digits.match(/^4?07\d{8}$/) ||  // 407xxxxxxxx veya 07xxxxxxxx
    digits.match(/^4?0\d{9}$/);     // 40xxxxxxxxx (geniş tolerans)
  if (!m) return null;

  let core = m[0];
  // normalize -> +40XXXXXXXXX
  core = core.replace(/^0/, '40');      // 07 -> 407
  core = core.startsWith('40') ? core : ('40' + core);
  return '+' + core;
}

// --- Session bootstrap ---
function bootstrap(chatId) {
  if (!sessions.has(chatId)) {
    const storeName = process.env.STORE_NAME || 'Pellvero';
    const systemPrompt = `
Ești un asistent de vânzări pe WhatsApp pentru magazinul online românesc "${storeName}".
Răspunde DOAR în română, scurt și politicos (max 5 rânduri).
Scop: finalizează comenzi COD.

Reguli stricte:
1) Nu cere telefon. Folosește "Număr WhatsApp" furnizat în context. Dacă clientul oferă în text un telefon nou, FOLOSEȘTE acel telefon în locul celui din WhatsApp și confirmă pe scurt.
2) Nume complet: trebuie să fie minim 2 cuvinte (ex. "Ion Popescu"). Dacă pare un singur cuvânt, cere politicos numele complet.
3) Adresa completă: stradă, număr, apartament (dacă există), cod poștal, oraș/județ. Dacă lipsește ceva important, cere fix acel detaliu.
4) Mărime: EU 35–46. 5) Culoare: negru sau maro. 6) Cantitate: 1 sau 2.
7) Clientul poate scrie amestecat (ex: "2 43 negru"). Înțelege și extrage.
8) NU trimite rezumat până nu ai: nume complet, adresă completă, mărime, culoare și cantitate. Dacă lipsește ceva, spune explicit ce lipsește și întreabă doar acel detaliu.
9) Rezumatul final să includă: nume, adresă, telefon ales, perechi, mărime, culoare, total (1=179,90 LEI; 2=279,90 LEI), livrare 7–10 zile, transport gratuit. Cere confirmare cu «DA» sau «MODIFIC».
10) La întrebări (preț, livrare, retur, IBAN) răspunde întâi la întrebare, apoi ghidează înapoi spre plasarea comenzii.
`.trim();

    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPrompt }]
    });
  }
  return sessions.get(chatId);
}

// --- AI çağrısı ---
async function askAI(chatId, userText) {
  const sess = bootstrap(chatId);

  // Konu çok büyümesin
  if (sess.history.length > 24) {
    sess.history = [sess.history[0], ...sess.history.slice(-12)];
  }

  // WhatsApp numarası
  const phoneWp = chatId.split('@')[0];
  let meta = `Număr WhatsApp: +${phoneWp}`;

  // Kullanıcı metninden farklı bir telefon geldiyse meta'ya açıkça yaz
  const phoneProvided = pickPhone(userText);
  if (phoneProvided) {
    meta += ` | Client a oferit telefon: ${phoneProvided} (folosește acesta în rezumat)`;
  }

  sess.history.push({ role: 'user', content: `${userText}\n\n(${meta})` });

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

    const sess = bootstrap(chatId);

    // Kontrol komutları
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
    if (lower.includes('noua') || lower.includes('nouă')) {
      sessions.delete(chatId);
      bootstrap(chatId);
      await msg.reply('Începem o nouă discuție. Cu ce vă pot ajuta?');
      return;
    }
    if (sess.muted) return;

    // Hızlı SSS
    for (const f of faqMap) {
      if (f.keys.some(k => lower.includes(k))) {
        await msg.reply(f.reply);
        await msg.reply('Doriți să continuăm cu plasarea comenzii?');
        return;
      }
    }

    // AI'ye gönder
    const reply = await askAI(chatId, text);
    if (reply) await msg.reply(reply);

  } catch (err) {
    console.error('❌ Hata:', err);
    try { await msg.reply('Ne pare rău, a apărut o eroare temporară. Încercați din nou.'); } catch {}
  }
});

// --- Express Keepalive & QR ---
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

client.initialize();
