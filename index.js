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

// --- Global ---
let lastQr = null;
const sessions = new Map();   // chatId -> { muted, history, stopReminders, missingFields, sentTaba, sentSiyah }
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
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// --- Ürün görselleri (isteğe bağlı yollar) ---
let IMG_TABA = null, IMG_SIYAH = null;
try {
  IMG_TABA  = MessageMedia.fromFilePath(process.env.IMG_TABA_PATH  || './media/taba.jpg');
} catch {}
try {
  IMG_SIYAH = MessageMedia.fromFilePath(process.env.IMG_SIYAH_PATH || './media/siyah.jpg');
} catch {}

// --- Yardımcılar (TR) ---
function pickPhoneTR(text) {
  const digits = (text || '').replace(/\D+/g, '');
  const ok = /^(?:0090|90)?5\d{9}$|^0?5\d{9}$/.test(digits);
  if (!ok) return null;
  let core = digits.replace(/^0090/, '').replace(/^90/, '').replace(/^0/, '');
  return '+90' + core;
}

// AI’dan gelen metindeki [MISSING: ...] etiketini oku
function extractMissing(reply) {
  const m = reply.match(/\[MISSING:([^\]]+)\]\s*$/i);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
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
      if (!sess || sess.muted || sess.stopReminders) return;
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
1) Telefonu proaktif isteme. WhatsApp numarasını meta’dan al. Müşteri yeni numara verirse “Bu numarayı teslimat için not aldım.” de ve onu kullan.
2) Ad soyad en az iki kelime olmalı. Tek kelime gelirse nazikçe tam ad iste.
3) Adres şunları içermeli: mahalle/cadde-sokak + kapı/daire, İLÇE ve İL. Posta kodu isteme.
4) Beden yalnızca 40–44. Renk yalnızca Siyah veya Taba. Adet 1 ya da 2. 2 adet ise iki renk/iki beden bilgisini netleştir.
5) Kullanıcı karışık yazarsa (örn: “2 43 siyah”) anla ve ayıkla.
6) Tüm alanlar tamamlanmadan özet gönderme; yalnızca eksik olan alanları iste.
7) Nihai özet: ad soyad, adres (ilçe/il), **seçilen telefon**, adet, beden(ler), renk(ler), toplam (1=${PRICE1}, 2=${PRICE2}), teslimat 2–5 iş günü, kargo ücretsiz ve şeffaf. Onay için “EVET”, değişiklik için “DÜZELT” iste.

TEKNİK FORMAT:
- Her cevabın SONUNDA sadece sistem için şu satırı ekle:
  [MISSING: ad_soyad,adres,ilce,il,beden,renk,adet]
  (Eksik olmayanları yazma; hiç eksik yoksa [MISSING: none]. Bu satırı müşteriye açıklama.)
`.trim();

    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPromptTR }],
      stopReminders: false,
      missingFields: ['ad_soyad','adres','ilce','il','beden','renk','adet'],
      sentTaba: false,
      sentSiyah: false
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
  let meta = `WhatsApp Numarası: +${phoneWp}`;

  const phoneProvided = pickPhoneTR(userText);
  if (phoneProvided) {
    meta += ` | Müşteri yeni telefon verdi: ${phoneProvided} (özette bunu kullan)`;
  }

  sess.history.push({ role: 'user', content: `${userText}\n\n(${meta})` });

  const res = await ai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    messages: sess.history
  });

  let reply = res.choices?.[0]?.message?.content || '';
  const missing = extractMissing(reply);
  if (missing && missing.length) sess.missingFields = missing;

  reply = reply.replace(/\s*\[MISSING:[^\]]+\]\s*$/i, '').trim();
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

    // Yalnızca "EVET" onayı gelince dürtmeyi kalıcı kes
    if (/^\s*evet\s*$/i.test(text)) {
      sess.stopReminders = true;
      clearTimeout(idleTimers.get(chatId));
    }

    // Kontrol komutları (TR)
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

    // SSS (önce)
    for (const f of faqMap) {
      if (f.keys.some(k => lower.includes(k))) {
        await msg.reply(f.reply);
        await msg.reply('Siparişinizi tamamlayalım mı? Lütfen ad soyad, adres (ilçe/il), numara (40–44), renk (Siyah/Taba) ve adet (1 veya 2) bilgisini yazınız.');
        if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
        return;
      }
    }

    // AI'ye gönder
    const reply = await askAI(chatId, text);
    if (reply) {
      await msg.reply(reply);
      if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
    }

  } catch (err) {
    console.error('❌ Hata:', err);
    try { await msg.reply('Üzgünüz, geçici bir hata oluştu. Lütfen tekrar deneyin.'); } catch {}
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
