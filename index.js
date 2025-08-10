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
const sessions = new Map();   // chatId -> { muted, history, orderClosed }
const idleTimers = new Map(); // chatId -> timeoutId (1 dk hatırlatma)
const PORT = process.env.PORT || 3000;

// --- WhatsApp Client ---
const client = new Client({
  authStrategy: new LocalAuth(),
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

// --- Hızlı SSS ---
const faqMap = [
  { keys: ['fiyat','ucret','ücret','price','preț'], reply: 'Prețuri: 1 pereche 179,90 LEI; 2 perechi 279,90 LEI. Transport gratuit, plată la livrare.' },
  { keys: ['iade','geri','return','retur'], reply: 'Retur în 14 zile calendaristice. Produs neutilizat și ambalaj intact.' },
  { keys: ['teslim','kargo','ne zaman','kaç günde','zaman','livrare','cât durează'], reply: 'Livrarea durează 7–10 zile lucrătoare. Transport gratuit.' },
  { keys: ['iban','havale','eft','banka','transfer'], reply: 'Plata la livrare (COD). Transfer bancar nu este necesar.' },
  { keys: ['site','website','link','adres'], reply: 'Site-ul nostru: https://pellvero.com/' },
];

// --- Kimlik soruları ---
const identityMap = [
  { keys: ['bot musun','robot','yapay zek','ai misin','insan mısın','eşti bot','esti bot','ești om','esti om','sunteți om'], 
    reply: 'Sunt asistent virtual al magazinului. Îți răspund rapid și politicos, iar dacă e nevoie te pot conecta la un operator uman.' }
];

// --- Yardımcılar ---
function pickPhone(text) {
  const digits = (text || '').replace(/\D+/g, '');
  const m =
    digits.match(/^4?07\d{8}$/) ||
    digits.match(/^4?0\d{9}$/);
  if (!m) return null;
  let core = m[0];
  core = core.replace(/^0/, '40');
  core = core.startsWith('40') ? core : ('40' + core);
  return '+' + core;
}

function isFinalOrderMessage(t = '') {
  t = t.toLowerCase();
  return (
    t.includes('comanda ta a fost finalizată cu succes') ||
    (t.includes('comanda a fost') && (t.includes('înregistrată') || t.includes('plasată'))) ||
    (t.includes('mulțumim') && t.includes('comanda')) ||
    ((t.includes('vei primi') || t.includes('veți primi')) && t.includes('zile'))
  );
}

function scheduleIdleReminder(chatId) {
  clearTimeout(idleTimers.get(chatId));
  const t = setTimeout(async () => {
    try {
      const sess = sessions.get(chatId);
      if (!sess || sess.muted || sess.orderClosed) return;
      await client.sendMessage(
        chatId,
        'Doriți să finalizăm comanda? Dacă aveți detaliile pregătite, îmi puteți scrie numele complet (prenume + nume), adresa, mărimea (EU 40–44), culoarea (negru/maro) și cantitatea (1 sau 2).'
      );
    } catch {}
  }, 60_000);
  idleTimers.set(chatId, t);
}

// --- Session bootstrap ---
function bootstrap(chatId) {
  if (!sessions.has(chatId)) {
    const storeName = process.env.STORE_NAME || 'Pellvero';
    const systemPrompt = `
Ești un asistent de vânzări pe WhatsApp pentru magazinul online românesc "${storeName}".
• Răspunde DOAR în română, scurt și politicos (max 5 rânduri).
• Scop: finalizează comenzi cu plată la livrare (COD).
[... kurallar aynı ...]
`.trim();

    sessions.set(chatId, {
      muted: false,
      orderClosed: false,
      history: [{ role: 'system', content: systemPrompt }]
    });
  }
  return sessions.get(chatId);
}

// --- AI çağrısı ---
async function askAI(chatId, userText) {
  const sess = bootstrap(chatId);

  if (sess.history.length > 24) {
    sess.history = [sess.history[0], ...sess.history.slice(-12)];
  }

  const phoneWp = chatId.split('@')[0];
  let meta = `Număr WhatsApp: +${phoneWp}`;

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

    clearTimeout(idleTimers.get(chatId));

    // Komutlar
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

    // Kimlik soruları
    for (const m of identityMap) {
      if (m.keys.some(k => lower.includes(k))) {
        await msg.reply(m.reply);
        scheduleIdleReminder(chatId);
        return;
      }
    }

    // SSS
    for (const f of faqMap) {
      if (f.keys.some(k => lower.includes(k))) {
        await msg.reply(f.reply);
        await msg.reply('Doriți să continuăm cu plasarea comenzii? Vă rog numele complet (prenume + nume), adresa, mărimea (EU 40–44), culoarea (negru/maro) și cantitatea (1 sau 2).');
        scheduleIdleReminder(chatId);
        return;
      }
    }

    // AI cevabı
    const reply = await askAI(chatId, text);
    if (reply) {
      await msg.reply(reply);

      if (isFinalOrderMessage(reply)) {
        sess.orderClosed = true;
        return; // hatırlatma kurma
      }

      scheduleIdleReminder(chatId);
    }

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
