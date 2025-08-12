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
const sessions = new Map();   // chatId -> { muted, history, stopReminders, missingFields, sentTaba, sentSiyah, data, order, _lastAsk, _rate }
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
try { IMG_TABA  = MessageMedia.fromFilePath(process.env.IMG_TABA_PATH  || './media/taba.jpg'); } catch (e) { console.warn('IMG_TABA yüklenemedi:', e.message); }
try { IMG_SIYAH = MessageMedia.fromFilePath(process.env.IMG_SIYAH_PATH || './media/siyah.jpg'); } catch (e) { console.warn('IMG_SIYAH yüklenemedi:', e.message); }

// --- Yardımcılar (TR) ---
function pickPhoneTR(text) {
  const digits = (text || '').replace(/\D+/g, '');
  const ok = /^(?:0090|90)?5\d{9}$|^0?5\d{9}$/.test(digits);
  if (!ok) return null;
  let core = digits.replace(/^0090/, '').replace(/^90/, '').replace(/^0/, '');
  return '+90' + core;
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
  beden: 'numara (40–44)',
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
7) Nihai özet: ad soyad, adres (ilçe/il), **seçilen telefon**, adet, beden(ler), renk(ler), toplam (1=${PRICE1}, 2=${PRICE2}), teslimat 2–5 iş günü, kargo ücretsiz ve şeffaf. Onay için “EVET”, değişiklik için “DÜZELT” iste.

TEKNİK FORMAT:
- Her cevabın SONUNDA sadece sistem için şu satırı ekle:
  [MISSING: ad_soyad,adres,ilce,il,beden,renk,adet]
  (Eksik olmayanları yazma; hiç eksik yoksa [MISSING: none]. Bu satırı müşteriye açıklama.)
- Ayrıca ikinci bir satır daha ekle:
  [FIELDS: ad_soyad=<...>; adres=<...>; ilce=<...>; il=<...>; beden=<...>; renk=<...>; adet=<...>]
  (Bilmediğin alanı boş bırak; örn. adet= )
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
      order: prev.order || null,
      _lastAsk: null,
      _rate: {}
    });
  }
  return sessions.get(chatId);
}

// --- AI: Alan çıkarımı (zorunlu JSON) ---
async function aiExtractFields(userText, history = []) {
  const sys = `
Sen bir alan-çıkarıcısın. SADECE geçerli tek satır JSON döndür.
ŞEMA:
{
  "ad_soyad": string | "",
  "adres": string | "",
  "ilce": string | "",
  "il": string | "",
  "beden": "40"|"41"|"42"|"43"|"44"|"",
  "renk": "Siyah"|"Taba"|"",
  "adet": "1"|"2"|"",
  "intent": "siparis"|"soru"|"iptal"|"tesekkur"|"diger"
}
KURALLAR:
- Renk eşleşmeleri: siyah/black -> "Siyah"; taba/kahverengi -> "Taba".
- "iki", "2" -> "2"; "bir", "1" -> "1".
- Ad soyad tek kelimeyse boş bırak.
- 40–44 dışı beden görürsen boş bırak.
- Sadece JSON yaz, açıklama YOK.
`.trim();

  const messages = [
    { role: 'system', content: sys },
    ...history.slice(-6),
    { role: 'user', content: userText }
  ];

  let out = "{}";
  try {
    const r = await ai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.1,
      messages
      // response_format JSON destekliyorsa ekleyebilirsin: response_format:{type:"json_object"}
    });
    out = r.choices?.[0]?.message?.content?.trim() || "{}";
  } catch {}

  let data;
  try { data = JSON.parse(out); } catch { data = null; }

  if (!data || typeof data !== 'object') {
    messages.unshift({ role:'system', content:'Yalnızca GEÇERLİ JSON yaz. Başka hiçbir şey yazma.' });
    const r2 = await ai.chat.completions.create({ model: OPENAI_MODEL, temperature: 0, messages });
    const out2 = r2.choices?.[0]?.message?.content?.trim() || "{}";
    try { data = JSON.parse(out2); } catch { data = {}; }
  }

  const norm = (s)=> String(s||'').trim();
  const bedenOk = /^(40|41|42|43|44)$/.test(norm(data?.beden||''));
  const renkMap = { siyah: 'Siyah', black: 'Siyah', taba: 'Taba', kahverengi: 'Taba' };
  const renkIn = norm(data?.renk||'').toLowerCase();
  const renkOk = renkMap[renkIn] || (['Siyah','Taba'].includes(data?.renk)?data.renk:'' );
  const adetOk = /^(1|2)$/.test(norm(data?.adet||'')) ? norm(data.adet) : '';

  return {
    ad_soyad: norm(data?.ad_soyad||''),
    adres: norm(data?.adres||''),
    ilce: norm(data?.ilce||''),
    il: norm(data?.il||''),
    beden: bedenOk ? norm(data?.beden) : '',
    renk: renkOk,
    adet: adetOk,
    intent: ['siparis','soru','iptal','tesekkur','diger'].includes(data?.intent) ? data.intent : 'diger'
  };
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

function shouldSend(chatId, key, ms=20000){
  const sess = sessions.get(chatId) || {};
  const now = Date.now();
  if (!sess._rate) sess._rate = {};
  if (sess._rate[key] && (now - sess._rate[key] < ms)) return false;
  sess._rate[key] = now;
  sessions.set(chatId, sess);
  return true;
}

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const text = (msg.body || '').trim();
    const lower = text.toLowerCase();

    const sess = bootstrap(chatId);

    // Yalnızca "EVET" onayı → dur
    if (/^\s*evet\s*$/i.test(text)) {
      sess.stopReminders = true;
      clearTimeout(idleTimers.get(chatId));
      if (!sess.order) sess.order = { status: 'hazirlaniyor' };
      const phoneWp = chatId.split('@')[0];
      saveCustomer('+'+phoneWp, { data: sess.data, order: sess.order });
      await msg.reply('Teşekkürler, siparişiniz hazırlanıyor. Kargoya verildiğinde bilgilendireceğiz.');
      return;
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

    // — Görsel talebi (AI'yi bypass et) — EN ÖNCE
    if (/\b(foto|fotoğraf|fotograf|resim|görsel)\b/i.test(lower) || /renk(leri|) (al|gör|goster|göster)/i.test(lower)) {
      const sent = [];
      if (sess.data.renk === 'Siyah' && IMG_SIYAH) { await client.sendMessage(chatId, IMG_SIYAH); sent.push('siyah'); }
      if (sess.data.renk === 'Taba'  && IMG_TABA)  { await client.sendMessage(chatId, IMG_TABA);  sent.push('taba'); }
      if (!sent.length) {
        if (IMG_SIYAH) await client.sendMessage(chatId, IMG_SIYAH);
        if (IMG_TABA)  await client.sendMessage(chatId, IMG_TABA);
      }
      const need = ['beden','renk','adet','ad_soyad','adres','ilce','il'].filter(k => !sess.data[k]);
      if (need.length && shouldSend(chatId,'ask_'+need[0])) {
        const q =
          need[0] === 'beden' ? 'Numaranız nedir? (40–44)' :
          need[0] === 'renk'  ? 'Hangi renk? (Siyah/Taba)' :
          need[0] === 'adet'  ? 'Kaç adet? (1 veya 2)' :
          need[0] === 'ad_soyad' ? 'Ad soyadınızı yazar mısınız? (iki kelime)' :
          need[0] === 'adres' ? 'Adres (mahalle/cadde + kapı/daire) nedir?' :
          need[0] === 'ilce'  ? 'Hangi ilçe?' : 'Hangi il?';
        await msg.reply(q);
      }
      if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
      return;
    }

    // --- Kargo durumu / takip soruları (AI bypass) ---
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

    // --- SSS (AI'siz hızlı yanıt) ---
    for (const f of faqMap) {
      if (f.keys.some(k => lower.includes(k))) {
        await msg.reply(f.reply);
        if (!sess.order && shouldSend(chatId,'after_faq')) {
          await msg.reply('Siparişinizi tamamlayalım mı? Lütfen ad soyad, adres (ilçe/il), numara (40–44), renk (Siyah/Taba) ve adet (1 veya 2) bilgisini yazınız.');
          if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
        }
        return;
      }
    }

    // --- AI ile alan çıkar (tek mesajdan çoklu değer) ---
    {
      const fields = await aiExtractFields(text, sess.history);
      let changed = false;
      for (const k of ['ad_soyad','adres','ilce','il','beden','renk','adet']) {
        if (fields[k] && fields[k] !== sess.data[k]) { sess.data[k] = fields[k]; changed = true; }
      }
      if (changed) {
        const phoneWp = chatId.split('@')[0];
        saveCustomer('+'+phoneWp, { data: sess.data, order: sess.order });
      }

      // Eksik → sıradaki eksik alanı tek tek iste
      const need = ['beden','renk','adet','ad_soyad','adres','ilce','il'].filter(k => !sess.data[k]);
      if (need.length) {
        if (shouldSend(chatId,'ask_'+need[0])) {
          const q =
            need[0] === 'beden' ? 'Numaranız nedir? (40–44)' :
            need[0] === 'renk'  ? 'Hangi renk? (Siyah/Taba)' :
            need[0] === 'adet'  ? 'Kaç adet? (1 veya 2)' :
            need[0] === 'ad_soyad' ? 'Ad soyadınızı yazar mısınız? (iki kelime)' :
            need[0] === 'adres' ? 'Adres (mahalle/cadde + kapı/daire) nedir?' :
            need[0] === 'ilce'  ? 'Hangi ilçe?' : 'Hangi il?';
          await msg.reply(q);
        }
        if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
        return;
      }

      // Hiç eksik yoksa → ÖZET ve onay
      if (!need.length) {
        const { ad_soyad, adres, ilce, il, beden, renk, adet } = sess.data;
        const total = (adet === '2') ? PRICE2 : PRICE1;
        await msg.reply(
          `Özet:\n- Ad Soyad: ${ad_soyad}\n- Adres: ${adres} (${ilce}/${il})\n- Beden: ${beden}\n- Renk: ${renk}\n- Adet: ${adet}\nToplam: ${total}\nTeslimat: 2–5 iş günü (kargo ücretsiz ve şeffaf).\nOnay için “EVET”, düzeltme için “DÜZELT” yazınız.`
        );
        sess.stopReminders = true;
        return;
      }
    }

    // --- (Gerekirse) serbest AI cevabı ---
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
