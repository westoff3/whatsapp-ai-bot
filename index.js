// === WhatsApp + OpenAI AI Sales Bot (ESM - AI ONLY, TR EDITION) ===
// Çalışma Ortamı: Railway / Node 18+
// ENV: OPENAI_API_KEY
// Opsiyonel ENV: STORE_NAME, OPENAI_MODEL (varsayılan gpt-4o-mini)
// Opsiyonel ENV: IMG_TABA_PATH, IMG_SIYAH_PATH  (örn: ./media/taba.jpg)

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';
import QRCode from 'qrcode';
import fs from 'fs';

// --- Mini-DB (JSON dosya) ---
const DB_PATH = './db.json';
function dbRead(){ try{ return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); } catch{ return {}; } }
function dbWrite(x){ fs.writeFileSync(DB_PATH, JSON.stringify(x, null, 2)); }
function getCustomer(phone){ const db=dbRead(); return db[phone] || { data:{}, order:null, updatedAt:0 }; }
function saveCustomer(phone, payload){ const db=dbRead(); db[phone] = { ...(db[phone]||{}), ...payload, updatedAt:Date.now() }; dbWrite(db); }

// --- Global ---
let lastQr = null;
const sessions = new Map();   // chatId -> { muted, history, stopReminders, missingFields, sentTaba, sentSiyah, data, order }
const idleTimers = new Map(); // chatId -> timeoutId (1 dk hatırlatma)
const PORT = process.env.PORT || 3000;

// --- De-dup guard (aynı mesaja tek cevap) ---
const processedMsgIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedMsgIds.has(id)) return true;
  processedMsgIds.add(id);
  setTimeout(() => processedMsgIds.delete(id), 5 * 60 * 1000); // 5 dk
  return false;
}

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
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// --- Ürün görselleri (isteğe bağlı yollar) ---
let IMG_TABA = null, IMG_SIYAH = null;
try { IMG_TABA  = MessageMedia.fromFilePath(process.env.IMG_TABA_PATH  || './media/taba.jpg'); } catch {}
try { IMG_SIYAH = MessageMedia.fromFilePath(process.env.IMG_SIYAH_PATH || './media/siyah.jpg'); } catch {}

// --- Yardımcılar (TR) ---
function pickPhoneTR(text) {
  const digits = (text || '').replace(/\D+/g, '');
  const ok = /^(?:0090|90)?5\d{9}$|^0?5\d{9}$/.test(digits);
  if (!ok) return null;
  let core = digits.replace(/^0090/, '').replace(/^90/, '').replace(/^0/, '');
  return '+90' + core;
}

// === Deterministik çıkarıcılar (40–44 dâhil) ===
function pickSizes(text) {
  if (!text) return [];
  const m = [...text.matchAll(/\b(40|41|42|43|44)\b/g)];
  return [...new Set(m.map(x => x[1]))];
}
function pickColors(text) {
  const t = (text||'').toLowerCase();
  const out = [];
  if (/\bsiyah\b/.test(t)) out.push('Siyah');
  if (/\btaba\b|\bkahverengi\b/.test(t)) out.push('Taba');
  return [...new Set(out)];
}
function pickQty(text) {
  const t = (text||'').toLowerCase();
  if (/\b2\b|\biki\b/.test(t)) return '2';
  if (/\b1\b|\bbir\b/.test(t)) return '1';
  return '';
}

// MODEL ETİKETLERİ OKUMA
function extractMissing(reply) {
  const all = [...String(reply).matchAll(/\[MISSING:([^\]]+)\]/gi)];
  if (!all.length) return null;
  const last = all[all.length - 1][1];
  return last.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function extractFields(reply){
  const m = reply.match(/\[FIELDS:\s*([^\]]*)\]/i);
  if (!m) return null;
  const out = {};
  m[1].split(';').forEach(pair=>{
    const [k,v] = pair.split('=');
    if (!k) return;
    out[k.trim().toLowerCase()] = (v||'').trim();
  });
  return out;
}

// Hatırlatma metni üret (yalnız eksikleri iste)
const labelsTR = {
  ad_soyad: 'ad soyad (iki kelime)',
  adres: 'açık adres (mahalle/cadde, kapı/daire)',
  ilce: 'ilçe',
  il: 'il',
  beden: 'numara (EU 40–44)',
  renk: 'renk (Siyah/Taba)',
  adet: 'adet (1 veya 2)'
};
function trJoin(keys){
  const arr = keys.map(k => labelsTR[k] || k);
  return arr.length <= 1 ? (arr[0]||'') : arr.slice(0,-1).join(', ') + ' ve ' + arr.slice(-1);
}
function buildReminderTextTR(missing){
  const ks = (missing||[]).filter(k => k!=='none');
  if (!ks.length) return 'Siparişi tamamlayalım mı? Onay verirseniz özet geçeceğim.';
  if (ks.length===2 && ks.includes('renk') && ks.includes('adet'))
    return 'Lütfen renk (Siyah/Taba) ve adet (1 veya 2) bilgisini yazın.';
  return `Lütfen şu bilgileri iletin: ${trJoin(ks)}.`;
}

// --- Fiyat & Site ---
const SITE = 'https://pellvero.com/products/klasik-erkek-ayakkabi-iki-renk-secenekli';
const PRICE1 = '999,90 TL';
const PRICE2 = '1.499,90 TL';

// --- Hızlı SSS (TR tetik / TR yanıt) ---
const faqMap = [
  { keys: ['fiyat','ucret','ücret','price'], reply: `1 adet ${PRICE1}. Ücretsiz ve şeffaf kargodur efendim. Kapıda ödemelidir. Hiçbir ek ücret yoktur.` },
  { keys: ['iki','çift','2 adet','paket','bundle'], reply: `2 adet ${PRICE2}. Ücretsiz ve şeffaf kargodur efendim. Kapıda ödemelidir. Hiçbir ek ücret yoktur.` },
  { keys: ['teslim','kargo','ne zaman','kaç günde','zaman','süre'], reply: 'Teşekkür ederiz efendim. Ortalama 2 ila 5 iş günü içinde size ulaşacaktır.' },
  { keys: ['görmeden','şeffaf','nasıl teslim','koli'], reply: 'Ücretsiz ve şeffaf kargodur. Kapıda ödemelidir. Ürününüzü görerek teslim alacaksınız. Görmeden ödeme yapmazsınız efendim.' },
  { keys: ['site','website','link','adres','nereden alırım'], reply: `Siparişinizi buradan oluşturabilirsiniz efendim: ${SITE}. Kargoya verilmeden önce çağrı merkezimiz sizi arayacaktır.` },
  { keys: ['indirim','pazarlık','düşer mi'], reply: 'İndirimli sabit barkotlu fiyatlarımızdır efendim.' },
  { keys: ['kalıp','standart kalıp','dar mı'], reply: 'Standart kalıptır efendim.' },
  { keys: ['numara','beden','ölçü'], reply: '40–44 numara aralığında mevcuttur efendim.' },
  {
    keys: [
      'nereden','nerden','hangi şehir','neresi','neredensiniz',
      'nereden gönder','nerden gönder','nereden gelecek','nerden gelecek',
      'nereden kargo','nereden çıkış','yerin nere','yeriniz neresi'
    ],
    reply: 'Konya’dan 81 ile göndermekteyiz efendim.'
  },
  { keys: ['iptal'], reply: 'İptal edilmiştir. Teşekkür eder, iyi günler dileriz efendim.' },
  { keys: ['aynı ürün mü','farklı mı','aynı mı'], reply: 'Birebir aynı üründür. Ücretsiz ve şeffaf kargodur. Kapıda ödemelidir. Ürününüzü görerek teslim alacaksınız.' },
  { keys: ['kart','kredi kartı','taksit'], reply: 'Tabi efendim. Kapıda kart ile ödeme yapabilirsiniz. Tek çekimdir; ardından bankanızdan taksitlendirebilirsiniz.' },
  { keys: ['malzeme','deri','taban'], reply: 'Deridir. Kauçuk termo ortopedik tabandır efendim. %100 yerli üretimdir. Kaliteli ürünlerdir.' },
  { keys: ['iade','geri','değişim','retur','return'], reply: 'Sadece Değişim mevcuttur efendim.' },
];

// --- Kimlik soruları ---
const identityMap = [
  { keys: ['bot musun','robot','yapay zek','ai misin','insan mısın'],
    reply: 'Mağaza asistanıyım. Hızlı yardımcı olurum, isterseniz temsilciye de aktarabilirim.' }
];

// --- 1 dk idle hatırlatma ---
function scheduleIdleReminder(chatId) {
  clearTimeout(idleTimers.get(chatId));
  const t = setTimeout(async () => {
    try {
      const sess = sessions.get(chatId);
      if (!sess || sess.muted || sess.stopReminders || sess.order) return;
      const msgText = buildReminderTextTR(Array.isArray(sess.missingFields)
        ? sess.missingFields
        : ['ad_soyad','adres','ilce','il','beden','renk','adet']);
      await client.sendMessage(chatId, msgText);
    } catch {}
  }, 60_000);
  idleTimers.set(chatId, t);
}

// --- Session bootstrap ---
function bootstrap(chatId) {
  if (!sessions.has(chatId)) {
    const storeName = process.env.STORE_NAME || 'Pellvero';
    const systemPromptTR = `
${storeName} için WhatsApp satış asistanısın.
• Yalnızca TÜRKÇE yaz ve kısa cevap ver (en fazla 5 satır).
• Amaç: Kapıda ödeme (COD) ile siparişi tamamlama.

KURALLAR:
1) Telefonu proaktif isteme. WhatsApp numarasını meta’dan al. Müşteri yeni numara verirse cevapta BAHSETME; özette bu numarayı kullan.
2) Ad soyad en az iki kelime olmalı. Tek kelime gelirse nazikçe tam ad iste.
3) Adres şunları içermeli: mahalle/cadde-sokak + kapı/daire, İLÇE ve İL. Posta kodu isteme.
4) Beden yalnızca 40–44. Renk yalnızca Siyah veya Taba. Adet 1 ya da 2. 2 adet ise iki renk/iki beden bilgisini netleştir.
5) Kullanıcı karışık yazarsa (örn: “2 43 siyah”) anla ve ayıkla.
6) Tüm alanlar tamamlanmadan özet gönderme; yalnızca eksik olan alanları iste.
7) Nihai özet MUTLAKA şu alanları bu biçimde içersin (BEDEN rakam şart):
   • **Ad Soyad:** ...
   • **Adres:** ... (İlçe/İl)
   • **Telefon:** +90...
   • **Adet:** 1|2
   • **Beden(ler):** 44  veya 43,44
   • **Renk(ler):** Siyah  veya Siyah,Taba
   • **Toplam:** 1=${PRICE1}, 2=${PRICE2}
   • **Teslimat:** 2–5 iş günü, kargo ücretsiz ve şeffaf
   Onay için “EVET”, değişiklik için “DÜZELT” iste.
8) Kullanıcı “44 numara” gibi kısa yazarsa bunu BEDEN olarak işle ve kaydet; asla atlama.

TEKNİK FORMAT:
- Her cevabın SONUNDA sadece sistem için şu satırı ekle:
  [MISSING: ad_soyad,adres,ilce,il,beden,renk,adet]
- Ayrıca ikinci bir satır daha ekle:
  [FIELDS: ad_soyad=<...>; adres=<...>; ilce=<...>; il=<...>; beden=<...>; renk=<...>; adet=<...>]
`.trim();

    const phoneWp = chatId.split('@')[0];
    const prev = getCustomer('+'+phoneWp);

    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPromptTR }],
      stopReminders: false,
      missingFields: ['ad_soyad','adres','ilce','il','beden','renk','adet'],
      sentTaba: false,
      sentSiyah: false,
      data: prev.data || { ad_soyad:'', adres:'', ilce:'', il:'', beden:'', renk:'', adet:'' },
      order: prev.order || null
    });
  }
  return sessions.get(chatId);
}

// --- AI çağrısı (asla çökmez; fallback var) ---
async function askAI(chatId, userText, metaHints='') {
  const sess = bootstrap(chatId);

  if (sess.history.length > 24) {
    sess.history = [sess.history[0], ...sess.history.slice(-12)];
  }

  const phoneWp = chatId.split('@')[0];
  let meta = `WhatsApp Numarası: +${phoneWp}`;
  if (metaHints) meta += ` | Ön-çıkarımlar: ${metaHints}`;

  const phoneProvided = pickPhoneTR(userText);
  if (phoneProvided) meta += ` | Müşteri yeni telefon verdi: ${phoneProvided} (özette bunu kullan)`;

  sess.history.push({ role: 'user', content: `${userText}\n\n(${meta})` });

  let reply = '';
  try {
    const res = await ai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.3,
      messages: sess.history
    });
    reply = res.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error('OpenAI hata:', e?.status || e?.code || e?.message);
    // Fallback: eksikleri iste – kullanıcıya hata göstermeden
    reply = buildReminderTextTR(Array.isArray(sess.missingFields) ? sess.missingFields : []);
  }

  const missing = extractMissing(reply);
  if (missing && missing.length) sess.missingFields = missing;

  const fields = extractFields(reply);
  if (fields) {
    sess.data = { ...sess.data, ...fields };
    saveCustomer('+'+phoneWp, { data: sess.data, order: sess.order });
  }

  reply = reply
    .replace(/\[MISSING:[^\]]+\]/gi, '')
    .replace(/\[FIELDS:[^\]]+\]/gi, '')
    .replace(/^[ \t]*\n+/gm, '')
    .trim();

  if (sess.order) reply = reply.replace(/.*siparişi tamamlayalım mı\?.*/gi, '').trim();
  if (!reply) reply = buildReminderTextTR(Array.isArray(sess.missingFields) ? sess.missingFields : []);

  sess.history.push({ role: 'assistant', content: reply });
  return reply;
}

// --- Özet olup olmadığını sez (guard) ---
function looksLikeSummary(txt){
  const t = (txt||'').toLowerCase();
  return /\bonaylandı\b|\btamamlandı\b|\bözet\b/.test(t);
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
  // DEDUPE: aynı mesajı ikinci kez işlemeyi kes
  const msgId = msg.id?._serialized || `${msg.from}-${msg.timestamp}-${(msg.body||'').length}`;
  if (alreadyProcessed(msgId)) return;

  try {
    if (msg.fromMe) return;
    // sistem/protokol mesajlarını yoksay
    if (!msg.body) return;
    const chatId = msg.from;
    const text = (msg.body || '').trim();
    const lower = text.toLowerCase();

    // WhatsApp'ın "Süreli mesajlar etkinleştirildi" vb. protokol metinlerini yoksay
    if (/süreli mesajlar etkinleştirildi/i.test(lower)) return;

    const sess = bootstrap(chatId);

    // "EVET" onayı
    if (/^\s*evet\s*$/i.test(text)) {
      sess.stopReminders = true;
      clearTimeout(idleTimers.get(chatId));
      if (!sess.order) sess.order = { status: 'hazirlaniyor' };
      const phoneWp = chatId.split('@')[0];
      saveCustomer('+'+phoneWp, { data: sess.data, order: sess.order });
    }

    // Kontrol komutları
    if (lower === 'temsilci') {
      sess.muted = true;
      await msg.reply('Sizi temsilciye aktarıyoruz. Teşekkürler!');
      return;
    }
    if (lower === 'bot' || lower === 'asistan') {
      sess.muted = false;
      sess.stopReminders = false;
      await msg.reply('Asistan yeniden aktif. Nasıl yardımcı olabilirim?');
      return;
    }
    if (lower.includes('yeni')) {
      sessions.delete(chatId);
      const s = bootstrap(chatId);
      s.sentTaba = false; s.sentSiyah = false;
      await msg.reply('Yeni bir görüşme başlatıldı. Size nasıl yardımcı olalım?');
      return;
    }
    if (sess.muted) return;

    // — Renk teyidi görseli (bir kez gönder)
    if (/\btaba\b/i.test(lower) || /\bkahverengi\b/i.test(lower)) {
      if (!sess.sentTaba && IMG_TABA) {
        await client.sendMessage(chatId, IMG_TABA);
        sess.sentTaba = true;
      }
    }
    if (/\bsiyah\b/i.test(lower) || /\bblack\b/i.test(lower)) {
      if (!sess.sentSiyah && IMG_SIYAH) {
        await client.sendMessage(chatId, IMG_SIYAH);
        sess.sentSiyah = true;
      }
    }

    // Kimlik soruları
    for (const m of identityMap) {
      if (m.keys.some(k => lower.includes(k))) {
        await msg.reply(m.reply);
        if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
        return;
      }
    }

    // --- Kargo / takip soruları ---
    const isCargoAsk = /\bkargo(m|)\b|\btakip\b|\bnerde\b|\bnerede\b|\bne zaman gelir\b/i.test(lower);
    if (isCargoAsk) {
      if (!sess.order) {
        await msg.reply('Sistemde tamamlanmış bir siparişiniz görünmüyor. Onayladıysanız “EVET” yazmış olmanız gerekir.');
      } else if (sess.order.status === 'hazirlaniyor') {
        await msg.reply('Siparişiniz hazırlanıyor, kargoya verildiğinde buradan bilgilendirileceksiniz.');
      } else if (sess.order.status === 'kargoda') {
        await msg.reply('Siparişiniz kargoya verildi, tahmini teslim 2–5 iş günü içinde. Detaylar en kısa sürede paylaşılacaktır.');
      } else if (sess.order.status === 'teslim') {
        await msg.reply('Siparişiniz teslim edilmiş görünüyor. Bir sorun varsa yazın, yardımcı olalım.');
      } else if (sess.order.status === 'iptal') {
        await msg.reply('Son siparişiniz iptal edilmiş görünüyor. Yeniden oluşturmak isterseniz yazın.');
      }
      if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
      return;
    }

    // === DETERMINİSTİK ÖN-ÇIKARIM ===
    const sizes = pickSizes(text);
    const colors = pickColors(text);
    const qty    = pickQty(text);

    if (qty) sess.data.adet = qty;
    if (sizes.length) {
      sess.data.beden = (sess.data.adet === '2' && sizes.length >= 2) ? `${sizes[0]},${sizes[1]}` : `${sizes[0]}`;
    }
    if (colors.length) {
      sess.data.renk = (sess.data.adet === '2' && colors.length >= 2) ? `${colors[0]},${colors[1]}` : `${colors[0]}`;
    }

    // ipuçlarını AI'ye geçir
    const hintsArr = [];
    if (sess.data.beden) hintsArr.push(`beden=${sess.data.beden}`);
    if (sess.data.renk)  hintsArr.push(`renk=${sess.data.renk}`);
    if (sess.data.adet)  hintsArr.push(`adet=${sess.data.adet}`);
    const metaHints = hintsArr.join('; ');

    // SSS (önce)
    for (const f of faqMap) {
      if (f.keys.some(k => lower.includes(k))) {
        await msg.reply(f.reply);
        if (!sess.order) {
          await msg.reply('Siparişinizi tamamlayalım mı? Lütfen ad soyad, adres (ilçe/il), numara (40–44), renk (Siyah/Taba) ve adet (1 veya 2) bilgisini yazınız.');
          if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
        }
        return;
      }
    }

    // AI'ye gönder
    const reply = await askAI(chatId, text, metaHints);

    // === ÖZET/GUARD KONTROLLERİ ===
    if (looksLikeSummary(reply)) {
      if (!sess.data.beden) {
        await msg.reply('Numara belirtilmemiş. Lütfen **EU 40–44** aralığında numarayı yazınız (örn: 44).');
        if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
        return;
      }
      if (sess.data.adet === '2') {
        const hasTwoSizes = (sess.data.beden||'').includes(',');
        const hasTwoColors = (sess.data.renk||'').includes(',');
        if (!hasTwoSizes) {
          await msg.reply('2 adet için iki **numara** belirtin (örn: 43,44).');
          if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
          return;
        }
        if (!sess.data.renk) {
          await msg.reply('2 adet için renk(ler)i belirtin (örn: Siyah,Taba veya iki kez Siyah).');
          if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
          return;
        }
      }
    }

    if (reply) {
      await msg.reply(reply);
      if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
    }

  } catch (err) {
    console.error('❌ Handler hata:', err?.message || err);
    // Kullanıcıya asla hata metni göstermeden güvenli fallback
    try {
      await msg.reply('Siparişi tamamlayalım mı? Lütfen ad soyad, adres (ilçe/il), numara (40–44), renk (Siyah/Taba) ve adet (1 veya 2) bilgisini yazınız.');
    } catch {}
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
