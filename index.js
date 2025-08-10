// === WhatsApp + OpenAI AI Sales Bot (ESM) ===
// Çalışma Ortamı: Railway / Node 18+
// Gerekli ENV: OPENAI_API_KEY, REDIS_URL
// Opsiyonel ENV: STORE_NAME
// Komutlar: "operator" -> botu sustur, "bot" -> tekrar aç, "nouă comandă" -> akışı resetle

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
const sessions = new Map(); // chatId -> {muted, history, stepIndex, order, awaitingConfirm}
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

// --- SSS (TR tetik / RO yanıt) ---
const faqMap = [
  { keys: ['fiyat','ucret','ücret','price','preț'], reply: 'Prețuri: 1 pereche 179,90 LEI; 2 perechi 279,90 LEI. Transport gratuit, plată la livrare.' },
  { keys: ['iade','geri','return','retur'], reply: 'Retur în 14 zile calendaristice. Produs neutilizat și ambalajul intact.' },
  { keys: ['teslim','kargo','ne zaman','kaç günde','zaman','livrare','cât durează'], reply: 'Livrarea: 7–10 zile lucrătoare. Transport gratuit.' },
  { keys: ['iban','havale','eft','banka','transfer'], reply: 'Plata la livrare (COD). Transfer bancar nu este necesar.' },
  { keys: ['site','website','link','adres'], reply: 'Site-ul nostru: https://pellvero.com/' },
];

// --- Manuel Sipariş Adımları ---
const SIZES = ['35','36','37','38','39','40','41','42','43','44','45','46'];
const COLORS = ['negru','maro'];
const ORDER_STEPS = [
  { key: 'name',     question: 'Vă rog să-mi spuneți numele complet (prenume + nume).' },
  { key: 'address',  question: 'Care este adresa completă (stradă, număr, apartament, cod poștal, oraș)?' },
  { key: 'size',     question: `Ce mărime doriți? (${SIZES.join(', ')})` },
  { key: 'color',    question: `Ce culoare preferați? (${COLORS.join(' / ')})` },
  { key: 'quantity', question: 'Câte perechi doriți? (1 sau 2)' }
];

// --- Session Başlatma ---
function bootstrap(chatId) {
  if (!sessions.has(chatId)) {
    const storeName = process.env.STORE_NAME || 'Pellvero';
    const systemPrompt = `
Ești un asistent de vânzări pentru magazinul online românesc "${storeName}".
Răspunde DOAR în română, scurt și politicos (max 5 rânduri).
Dacă utilizatorul pune întrebări generale (preț, livrare, retur), răspunde concis.
În rest, conversația este gestionată de un flux de comandă separat.
`.trim();

    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPrompt }],
      stepIndex: 0,
      awaitingConfirm: false,
      order: {
        phone: chatId.split('@')[0], // WP'den otomatik
        name: '',
        address: '',
        size: '',
        color: '',
        quantity: ''
      }
    });
  }
  return sessions.get(chatId);
}

// --- Yardımcılar ---
function includesAny(haystack, keys) {
  const t = haystack.toLowerCase();
  return keys.some(k => t.includes(k));
}

function currentQuestion(sess) {
  if (sess.awaitingConfirm) return null;
  if (sess.stepIndex < ORDER_STEPS.length) {
    return ORDER_STEPS[sess.stepIndex].question;
  }
  return null;
}

function validateAndFill(sess, text) {
  const o = sess.order;
  const step = ORDER_STEPS[sess.stepIndex]?.key;

  if (step === 'name') {
    const words = text.trim().split(/\s+/);
    if (words.length >= 2 && words.join(' ').length >= 5) {
      o.name = words.map(w => w[0]?.toUpperCase()+w.slice(1)).join(' ');
      sess.stepIndex++;
      return { ok: true };
    }
    return { ok: false, msg: 'Te rog numele și prenumele (două cuvinte). Exemplu: Ion Popescu.' };
  }

  if (step === 'address') {
    if (text.trim().length < 12) {
      return { ok: false, msg: 'Adresa pare incompletă. Te rog: stradă, număr, apartament, cod poștal, oraș.' };
    }
    o.address = text.trim();
    sess.stepIndex++;
    return { ok: true };
  }

  if (step === 'size') {
    const m = text.match(/\b(3[5-9]|4[0-6])\b/);
    if (!m) return { ok: false, msg: `Te rog alege o mărime validă: ${SIZES.join(', ')}` };
    o.size = m[0];
    sess.stepIndex++;
    return { ok: true };
  }

  if (step === 'color') {
    const low = text.toLowerCase();
    // TR -> RO eşlemeleri
    const tr2ro = { siyah: 'negru', kahverengi: 'maro', siyahı: 'negru', kahverengı: 'maro', 'kahverengİ': 'maro' };
    let color = COLORS.find(c => low.includes(c));
    if (!color) {
      for (const [tr, ro] of Object.entries(tr2ro)) {
        if (low.includes(tr)) { color = ro; break; }
      }
    }
    if (!color) return { ok: false, msg: `Te rog alege o culoare: ${COLORS.join(' / ')}` };
    o.color = color;
    sess.stepIndex++;
    return { ok: true };
  }

  if (step === 'quantity') {
    const m = text.match(/\b[12]\b/);
    if (!m) return { ok: false, msg: 'Te rog scrie 1 sau 2.' };
    o.quantity = m[0];
    // adımlar bitti → onay bekle
    sess.awaitingConfirm = true;
    return { ok: true };
  }

  return { ok: false };
}

function orderSummary(sess) {
  const o = sess.order;
  const total = o.quantity === '2' ? '279,90 LEI' : '179,90 LEI';
  return (
`🛒 Rezumat comandă:
- Nume: ${o.name}
- Adresă: ${o.address}
- Telefon: +${o.phone}
- Perechi: ${o.quantity}
- Mărime: ${o.size}
- Culoare: ${o.color}
- Total: ${total}
- Livrare: 7–10 zile lucrătoare, transport gratuit, plată la livrare.

Confirmați cu „DA” sau scrieți „MODIFIC”.`
  );
}

// --- AI (sadece akış dışı / serbest sohbet) ---
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

    const sess = bootstrap(chatId);

    // --- Komutlar ---
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
      const s2 = bootstrap(chatId);
      await msg.reply('Începem o nouă comandă. ' + ORDER_STEPS[0].question);
      return;
    }
    if (sess.muted) return;

    // --- SSS & site (her zaman önce) ---
    for (const f of faqMap) {
      if (includesAny(lower, f.keys)) {
        await msg.reply(f.reply);
        // akış varsa kaldığı soruyu tekrar hatırlat
        const q = currentQuestion(sess);
        if (q) await msg.reply(q);
        return;
      }
    }

    // --- Onay bekleniyor mu? ---
    if (sess.awaitingConfirm) {
      if (lower === 'da') {
        sess.awaitingConfirm = false;
        await msg.reply('Mulțumim! Comanda a fost înregistrată. Veți primi livrarea în 7–10 zile lucrătoare.');
        // burada isterseniz siparişi bir webhook/Google Sheet/Shopify’a gönderin
        sessions.delete(chatId); // akışı sıfırla (yeni sipariş için)
        return;
      }
      if (lower.startsWith('modific')) {
        // en çok değiştirilen alanlara küçük kısayol yazabilirsiniz, şimdilik baştan soralım
        sess.stepIndex = 2; // beden adımına dönmek isterseniz değiştirebilirsiniz
        sess.awaitingConfirm = false;
        await msg.reply('Ce doriți să modificați? Reluăm de la mărime.');
        await msg.reply(ORDER_STEPS[sess.stepIndex].question);
        return;
      }
      await msg.reply('Te rog răspunde cu „DA” pentru confirmare sau „MODIFIC”.');
      return;
    }

    // --- Sipariş akışı içinde miyiz? ---
    if (sess.stepIndex < ORDER_STEPS.length) {
      const v = validateAndFill(sess, text);
      if (!v.ok) {
        await msg.reply(v.msg || 'Te rog răspunde corect.');
        return;
      }
      // adım başarıyla geçtiyse sıradaki soru / veya özet
      if (sess.awaitingConfirm) {
        // adımlar bitti → özet ver
        await msg.reply(orderSummary(sess));
        return;
      } else {
        await msg.reply(ORDER_STEPS[sess.stepIndex].question);
        return;
      }
    }

    // --- Akışta değilse: AI fallback ---
    const phoneFromWp = chatId.split('@')[0];
    const injected = `${text}\n(Număr WhatsApp: ${phoneFromWp})`;
    const reply = await askAI(chatId, injected);
    if (reply) await msg.reply(reply);

  } catch (err) {
    console.error('❌ Hata:', err);
    try { await msg.reply('Ne pare rău, a apărut o eroare temporară. Încercați din nou.'); } catch {}
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
