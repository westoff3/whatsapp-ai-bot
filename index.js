// === WhatsApp + OpenAI AI Sales Bot (ESM, TR) — Advanced ===
// package.json -> { "type": "module" }
import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import OpenAI from 'openai';
import express from 'express';
import QRCode from 'qrcode';
import fs from 'fs';

// -------------------- ENV --------------------
const PORT = process.env.PORT || 3000;
const STORE_NAME = process.env.STORE_NAME || 'Pellvero';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// -------------------- OpenAI --------------------
const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------- Mini DB (JSON) --------------------
const DB_PATH = './db.json';
function dbRead(){ try{ return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); } catch{ return {}; } }
function dbWrite(x){ fs.writeFileSync(DB_PATH, JSON.stringify(x, null, 2)); }
function getCustomer(phone){ const db=dbRead(); return db[phone] || { data:{}, order:null, updatedAt:0 }; }
function saveCustomer(phone, payload){ const db=dbRead(); db[phone] = { ...(db[phone]||{}), ...payload, updatedAt:Date.now() }; dbWrite(db); }

// -------------------- Assets (opsiyonel) --------------------
let IMG_TABA = null, IMG_SIYAH = null;
try { IMG_TABA  = MessageMedia.fromFilePath(process.env.IMG_TABA_PATH  || './media/taba.jpg'); } catch { /* ignore */ }
try { IMG_SIYAH = MessageMedia.fromFilePath(process.env.IMG_SIYAH_PATH || './media/siyah.jpg'); } catch { /* ignore */ }

// -------------------- WhatsApp Client --------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox','--disable-setuid-sandbox']
  }
});

let lastQr = null;
client.on('qr', (qr) => { lastQr = qr; qrcode.generate(qr, { small:true }); console.log('🔑 QR hazır. WhatsApp > Bağlı Cihazlar > Cihaz Bağla.'); });
client.on('ready', () => console.log('✅ WhatsApp bot hazır.'));
client.on('auth_failure', (m) => console.error('❌ Auth Failure:', m));
client.on('disconnected', (r) => console.warn('⚠️ Disconnected:', r));

// -------------------- Helpers --------------------
const SITE = 'https://pellvero.com/products/klasik-erkek-ayakkabi-iki-renk-secenekli';
const PRICE1 = '999,90 TL';
const PRICE2 = '1.499,90 TL';

// Bazı yasaklı ifadeleri tekilleştir (cevap sanitizasyonu)
const BANNED = [/hakiki\s*deri/gi, /%100\s*deri/gi];
function sanitizeText(s){ let out=String(s||''); for (const r of BANNED) out=out.replace(r,'Deridir'); return out; }

function pickPhoneTR(text) {
  const digits = (text || '').replace(/\D+/g, '');
  const ok = /^(?:0090|90)?5\d{9}$|^0?5\d{9}$/.test(digits);
  if (!ok) return null;
  let core = digits.replace(/^0090/, '').replace(/^90/, '').replace(/^0/, '');
  return '+90' + core;
}

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

const labelsTR = {
  ad_soyad: 'ad soyad (iki kelime)',
  adres: 'açık adres (mahalle/cadde, kapı/daire)',
  ilce: 'ilçe',
  il: 'il',
  beden: 'numara (40–44)',
  renk: 'renk (Siyah/Taba)',
  adet: 'adet (1 veya 2)'
};
function trJoin(keys){ const arr = keys.map(k => labelsTR[k] || k); return arr.length <= 1 ? (arr[0]||'') : arr.slice(0,-1).join(', ') + ' ve ' + arr.slice(-1); }
function buildReminderTextTR(missing){
  const ks = (missing||[]).filter(k => k!=='none');
  if (!ks.length) return 'Siparişi tamamlayalım mı? Onay verirseniz özet geçeceğim.';
  if (ks.length===2 && ks.includes('renk') && ks.includes('adet')) return 'Lütfen renk (Siyah/Taba) ve adet (1 veya 2) bilgisini yazın.';
  return `Lütfen şu bilgileri iletin: ${trJoin(ks)}.`;
}

const faqMap = [
  { regex: /(2\s*adet|çift)/i, reply: `2 adet ${PRICE2}. Ücretsiz ve şeffaf kargodur. Kapıda ödeme.` },
  { regex: /(fiyat|ücret|price)/i, reply: `1 adet ${PRICE1}. Ücretsiz ve şeffaf kargodur. Kapıda ödeme.` },
  { regex: /(teslim|kargo|kaç günde|ne zaman|süre)/i, reply: 'Ortalama 2–5 iş günü içinde teslim.' },
  { regex: /(görmeden|şeffaf|nasıl teslim|koli)/i, reply: 'Şeffaf kargo. Ürünü görerek teslim alırsınız; görmeden ödeme yok.' },
  { regex: /(site|website|link|adres|nereden alırım)/i, reply: `Sipariş sayfası: ${SITE}. Çağrı merkezi kargoya verilmeden önce arar.` },
  { regex: /(indirim|pazarlık|düşer mi)/i, reply: 'İndirimli sabit barkotlu fiyat.' },
  { regex: /(kalıp|standart kalıp|dar m[ıi])/i, reply: 'Standart kalıp.' },
  { regex: /(numara|beden|ölçü)/i, reply: '40–44 numara mevcut.' },
  { regex: /(nereden|hangi şehir|nereden gönder|yeriniz)/i, reply: 'Konya’dan 81 ile gönderiyoruz.' },
  { regex: /iptal/i, reply: 'İptal edilmiştir. Teşekkür ederiz.' },
  { regex: /(aynı ürün mü|farklı mı|aynı mı)/i, reply: 'Birebir aynı ürün. Şeffaf kargo, kapıda ödeme.' },
  { regex: /(kart|kredi kart[ıi]|taksit)/i, reply: 'Kapıda kart tek çekim; bankanız taksitlendirebilir.' },
  { regex: /(malzeme|deri|taban)/i, reply: 'Deridir. Kauçuk termo ortopedik tabandır. %100 yerli üretim.' },
  { regex: /(iade|geri|değişim|retur|return)/i, reply: 'Sadece değişim mevcuttur.' },
];

const identityMap = [
  { keys: ['bot musun','robot','yapay zek','ai misin','insan mısın'], reply: 'Mağaza asistanıyım. Hızlı yardımcı olurum; isterseniz temsilciye aktarabilirim.' }
];

const ILER = ['adana','adiyaman','afyonkarahisar','ağrı','amasya','ankara','antalya','artvin','aydın','balıkesir','bilecik','bingöl','bitlis','bolu','burdur','bursa','çanakkale','çankırı','çorum','denizli','diyarbakır','edirne','elazığ','erzincan','erzurum','eskişehir','gaziantep','giresun','gümüşhane','hakkari','hatay','ısparta','mersin','istanbul','izmir','kars','kastamonu','kayseri','kırklareli','kırşehir','kocaeli','konya','kütahya','malatya','manisa','kahramanmaraş','mardin','muğla','muş','nevşehir','niğde','ordu','rize','sakarya','samsun','siirt','sinop','sivas','tekirdağ','tokat','trabzon','tunceli','şanlıurfa','uşak','van','yozgat','zonguldak','aksaray','bayburt','karaman','kırıkkale','batman','şırnak','bartın','ardahan','ığdır','yalova','karabük','kilis','osmaniye','düzce'];

function parseOrderText(t){
  const lower=t.toLowerCase();
  const sizes = [...lower.matchAll(/\b4[0-4]\b/g)].map(m=>m[0]);
  const want2 = /(2\s*adet|iki|çift)/.test(lower) || Number((lower.match(/\b[12]\b/)||[])[0])===2;
  const colors = { siyah: /\bsiyah\b/.test(lower), taba: /\b(taba|kahverengi)\b/.test(lower) };
  const items=[];
  if (want2) {
    const s = sizes[0]||sizes[1]||null;
    if (s && colors.siyah && colors.taba) items.push({beden:s,renk:'Siyah'},{beden:s,renk:'Taba'});
    else if (sizes.length>=2 && colors.siyah) items.push({beden:sizes[0],renk:'Siyah'},{beden:sizes[1],renk: colors.taba?'Taba':'Siyah'});
    else if (sizes.length>=2 && colors.taba) items.push({beden:sizes[0],renk:'Taba'},{beden:sizes[1],renk:'Taba'});
    else if (sizes.length>=2) items.push({beden:sizes[0],renk:''},{beden:sizes[1],renk:''});
    else if (s) items.push({beden:s,renk:''},{beden:s,renk:''});
  } else {
    const s = sizes[0]||null;
    if (s) items.push({beden:s,renk: colors.siyah?'Siyah':(colors.taba?'Taba':'')});
  }
  return { items, adet: items.length|| (want2?2: (items.length?1:0)) };
}

function patchAddress(data, raw){
  const t = (raw||'').toLowerCase().replace(/\s+/g,' ').trim();
  if (!data.il) {
    const f = ILER.find(x=> t.endsWith(' '+x) || t.includes(' '+x+' '));
    if (f) data.il = f.toUpperCase();
  }
  if (!data.ilce) {
    if (/\bmeram\b/.test(t)) data.ilce='MERAM';
    if (/\bödemiş\b/.test(t)) data.ilce='ÖDEMİŞ';
  }
  if (!data.adres) {
    const m = t.match(/(mah(alle)?|mh\.?)\s*[^,]+|sok(a|.)?\s*[^,]+|cad(de)?\s*[^,]+|no\.?\s*\d+/g);
    if (m) data.adres = m.join(' ').replace(/\s{2,}/g,' ').trim();
  }
}

function missingFields(data){
  const d = data||{}; const miss=[]; const it = d.items||[];
  if (!d.ad_soyad?.trim() || !/\S+\s+\S+/.test(d.ad_soyad)) miss.push('ad_soyad');
  if (!d.adres?.trim()) miss.push('adres');
  if (!d.ilce?.trim()) miss.push('ilce');
  if (!d.il?.trim()) miss.push('il');
  if (!it.length) { miss.push('beden','renk','adet'); }
  else {
    if (it.some(x=>!x.beden)) miss.push('beden');
    if (it.some(x=>!x.renk)) miss.push('renk');
    if (!(d.adet===1 || d.adet===2)) miss.push('adet');
  }
  return [...new Set(miss)];
}
const hasAll = (data) => missingFields(data).length===0;

function summaryText(d){
  const items = (d.items||[]).map((x,i)=>`• ${i+1}) ${x.beden} – ${x.renk}`).join('\n');
  const total = ((d.items||[]).length>=2) ? PRICE2 : PRICE1;
  const phone = d.phone || '';
  return `Sipariş özeti:\nAd Soyad: ${d.ad_soyad}\nAdres: ${d.adres}, ${d.ilce}/${d.il}\nTelefon: ${phone}\nÜrünler:\n${items}\nToplam: ${total}\nTeslimat: 2–5 iş günü | Kargo: Ücretsiz ve şeffaf\nÖdeme: Kapıda nakit/kart\nOnay için “EVET”, düzeltmek için “DÜZELT” yazın.`;
}

// 1 dk idle hatırlatma
const idleTimers = new Map(); // chatId -> timeoutId
function scheduleIdleReminder(chatId) {
  clearTimeout(idleTimers.get(chatId));
  const t = setTimeout(async () => {
    try {
      const sess = sessions.get(chatId);
      if (!sess || sess.muted || sess.stopReminders || sess.order) return;
      const msgText = buildReminderTextTR(missingFields(sess.data));
      await client.sendMessage(chatId, msgText);
    } catch {}
  }, 60_000);
  idleTimers.set(chatId, t);
}

// -------------------- Sessions --------------------
const sessions = new Map(); // chatId -> state
function bootstrap(chatId) {
  if (!sessions.has(chatId)) {
    const systemPromptTR = `
${STORE_NAME} için WhatsApp satış asistanısın.
• Yalnızca TÜRKÇE yaz ve kısa cevap ver (en fazla 5 satır).
• Amaç: Kapıda ödeme (COD) ile siparişi tamamlama.

KURALLAR:
1) Telefonu proaktif isteme. WhatsApp numarasını meta’dan al. Müşteri yeni numara verirse cevapta BAHSETME; özette bu numarayı kullan.
2) Ad soyad en az iki kelime olmalı.
3) Adres: mahalle/cadde-sokak + kapı/daire, İLÇE ve İL. Posta kodu isteme.
4) Beden 40–44. Renk Siyah/Taba. Adet 1 ya da 2.
5) Karışık metni anla (örn: “2 43 siyah”).
6) Tüm alanlar tamamlanmadan özet gönderme; sadece eksikleri iste.
7) Nihai özet: ad soyad, adres (ilçe/il), **seçilen telefon**, adet, beden(ler), renk(ler), toplam (1=${PRICE1}, 2=${PRICE2}), teslimat 2–5 iş günü, kargo: ücretsiz ve şeffaf. Onay: “EVET”, düzeltme: “DÜZELT”.

TEKNİK FORMAT:
- Her cevabın SONUNDA yalnızca sistem için şunu ekle:
  [MISSING: ad_soyad,adres,ilce,il,beden,renk,adet]
  (Eksik olmayanları yazma; eksik yoksa [MISSING: none])
- Ek olarak:
  [FIELDS: ad_soyad=<...>; adres=<...>; ilce=<...>; il=<...>; beden=<...>; renk=<...>; adet=<...>]
  (Bilinmeyeni boş bırak)
`.trim();

    const phoneWp = chatId.split('@')[0];
    const prev = getCustomer('+'+phoneWp);
    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPromptTR }],
      stopReminders: false,
      sentTaba: false,
      sentSiyah: false,
      lastFaqAt: 0,
      data: prev.data && Object.keys(prev.data).length ? prev.data : { ad_soyad:'', adres:'', ilce:'', il:'', items:[], adet:0, phone: ('+'+phoneWp) },
      order: prev.order || null
    });
  }
  return sessions.get(chatId);
}

async function askAI(chatId, userText) {
  const sess = bootstrap(chatId);
  if (sess.history.length > 24) sess.history = [sess.history[0], ...sess.history.slice(-12)];

  const phoneWp = chatId.split('@')[0];
  let meta = `WhatsApp Numarası: +${phoneWp}`;
  const phoneProvided = pickPhoneTR(userText);
  if (phoneProvided) { meta += ` | Müşteri yeni telefon verdi: ${phoneProvided} (özette bunu kullan)`; sess.data.phone = phoneProvided; }

  const stateSummary = { ...sess.data, items: (sess.data.items||[]).slice(0,2) };
  sess.history.push({ role: 'system', content: `STATE: ${JSON.stringify(stateSummary)}` });
  sess.history.push({ role: 'user', content: `${userText}\n\n(${meta})` });

  const res = await ai.chat.completions.create({ model: OPENAI_MODEL, temperature: 0.3, messages: sess.history });
  let reply = res.choices?.[0]?.message?.content || '';

  const missing = extractMissing(reply);
  if (missing && missing.length) sess.missingFields = missing;

  const fields = extractFields(reply);
  if (fields) {
    const normMap = { 'ad soyad':'ad_soyad','adı soyadı':'ad_soyad','ilçe':'ilce','il ':'il','beden ':'beden','renk ':'renk','adet ':'adet' };
    const normalized = Object.fromEntries(Object.entries(fields).map(([k,v])=>[(normMap[k]||k),v]));
    sess.data = { ...sess.data, ...normalized };
    const phoneWp2 = chatId.split('@')[0];
    saveCustomer('+'+phoneWp2, { data: sess.data, order: sess.order });
  }

  reply = reply.replace(/\[MISSING:[^\]]+\]/gi, '').replace(/\[FIELDS:[^\]]+\]/gi, '').replace(/^[ \t]*\n+/gm, '').trim();
  if (sess.order) reply = reply.replace(/.*siparişi tamamlayalım mı\?.*/gi, '').trim();
  if (!reply) { const miss = missingFields(sess.data); reply = miss.length ? buildReminderTextTR(miss) : summaryText(sess.data); }

  sess.history.push({ role: 'assistant', content: reply });
  return sanitizeText(reply);
}

// -------------------- Message Handler --------------------
client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const chatId = msg.from;
    const text = (msg.body || '').trim();
    const lower = text.toLowerCase();

    const sess = bootstrap(chatId);

    const chat = await msg.getChat().catch(()=>null);
    if (chat) await chat.sendStateTyping();

    // Hızlı yanıt – malzeme
    if (/(\bderi\b|\bmalzeme\b)/i.test(lower)) {
      await msg.reply('Deridir. Kauçuk termo ortopedik tabandır. %100 yerli üretim.');
      if (chat) chat.clearState();
      return;
    }

    // Görsel istenirse ikisini de gönder
    if (/(foto(ğraf)?|resim|görsel)/i.test(lower)) {
      if (IMG_SIYAH) await client.sendMessage(chatId, IMG_SIYAH);
      if (IMG_TABA) await client.sendMessage(chatId, IMG_TABA);
      const miss = missingFields(sess.data);
      if (miss.length) await msg.reply(buildReminderTextTR(miss));
      if (chat) chat.clearState();
      scheduleIdleReminder(chatId);
      return;
    }

    // EVET / DÜZELT akışı
    if (/^\s*evet\s*$/i.test(text)) {
      sess.stopReminders = true;
      clearTimeout(idleTimers.get(chatId));
      if (!sess.order) sess.order = { status: 'hazirlaniyor', at: Date.now(), data: sess.data };
      const phoneWp = chatId.split('@')[0];
      saveCustomer('+'+phoneWp, { data: sess.data, order: sess.order });
      await msg.reply('Teşekkürler, siparişiniz hazırlanıyor. Kargoya verildiğinde bilgilendireceğiz.');
      if (chat) chat.clearState();
      return;
    }
    if (/^\s*düzel(t|tmek)?\s*$/i.test(text)) {
      sess.stopReminders=false;
      const miss = missingFields(sess.data);
      await msg.reply(buildReminderTextTR(miss));
      if (chat) chat.clearState();
      scheduleIdleReminder(chatId);
      return;
    }

    // Kontrol komutları
    if (lower === 'temsilci') { sess.muted = true; await msg.reply('Sizi temsilciye aktarıyoruz.'); if (chat) chat.clearState(); return; }
    if (lower === 'bot' || lower === 'asistan') { sess.muted = false; sess.stopReminders=false; await msg.reply('Asistan aktif.'); if (chat) chat.clearState(); return; }
    if (lower.includes('yeni')) { sessions.delete(chatId); bootstrap(chatId); await msg.reply('Yeni görüşme başlatıldı.'); if (chat) chat.clearState(); return; }
    if (sess.muted) { if (chat) chat.clearState(); return; }

    // Hızlı alan yakalama (AI öncesi)
    {
      const p = parseOrderText(text);
      if (p.items.length) {
        const now = Array.isArray(sess.data.items) ? sess.data.items : [];
        for (const it of p.items){
          const idx = now.findIndex(x=>!x.beden || !x.renk);
          if (idx>=0) now[idx] = { beden: it.beden||now[idx]?.beden||'', renk: it.renk||now[idx]?.renk||'' };
          else if (now.length<2) now.push({ beden: it.beden||'', renk: it.renk||'' });
        }
        sess.data.items = now.slice(0,2);
        sess.data.adet = Math.max(sess.data.adet||0, sess.data.items.length);
      }

      const mSize = lower.match(/(^|\D)(4[0-4])(?!\d)/);
      if (mSize) {
        if (!sess.data.items || !sess.data.items.length) sess.data.items=[{beden:mSize[2],renk:''}];
        else { const idx = sess.data.items.findIndex(x=>!x.beden); if (idx>=0) sess.data.items[idx].beden = mSize[2]; else if (sess.data.items.length<2) sess.data.items.push({beden:mSize[2],renk:''}); }
      }
      const mQty = lower.match(/(^|\s)([12])(\s*adet)?(\s|$)/);
      if (mQty) sess.data.adet = Number(mQty[2]);
      if (/\bsiyah\b|black/i.test(lower)) {
        if (!sess.data.items || !sess.data.items.length) sess.data.items=[{beden:'',renk:'Siyah'}];
        else { const idx = sess.data.items.findIndex(x=>!x.renk); if (idx>=0) sess.data.items[idx].renk = 'Siyah'; else if (sess.data.items.length<2) sess.data.items.push({beden:'',renk:'Siyah'}); }
      }
      if (/\btaba\b|kahverengi/i.test(lower)) {
        if (!sess.data.items || !sess.data.items.length) sess.data.items=[{beden:'',renk:'Taba'}];
        else { const idx = sess.data.items.findIndex(x=>!x.renk); if (idx>=0) sess.data.items[idx].renk = 'Taba'; else if (sess.data.items.length<2) sess.data.items.push({beden:'',renk:'Taba'}); }
      }

      if (!sess.data.ad_soyad && /^\s*[a-zçğıöşü]+(?:\s+[a-zçğıöşü]+)+\s*$/i.test(text) && !/\d/.test(text)) {
        sess.data.ad_soyad = text.trim().replace(/\s+/g,' ');
      }
      patchAddress(sess.data, text);

      const phoneWp = chatId.split('@')[0];
      saveCustomer('+'+phoneWp, { data: sess.data, order: sess.order });

      if (mSize && !/\bsiyah\b|\btaba\b|kahverengi/i.test(lower) && !mQty) {
        await msg.reply(`${mSize[2]} not edildi. Renk (Siyah/Taba) ve adet (1 veya 2) yazın.`);
        if (chat) chat.clearState();
        scheduleIdleReminder(chatId);
        return;
      }
    }

    // Renk teyidi görseli (bir kere)
    if (/\btaba\b/i.test(lower) || /\bkahverengi\b/i.test(lower)) { if (!sess.sentTaba && IMG_TABA) { await client.sendMessage(chatId, IMG_TABA); sess.sentTaba = true; } }
    if (/\bsiyah\b/i.test(lower) || /\bblack\b/i.test(lower)) { if (!sess.sentSiyah && IMG_SIYAH) { await client.sendMessage(chatId, IMG_SIYAH); sess.sentSiyah = true; } }

    // Kimlik soruları
    for (const m of identityMap) { if (m.keys.some(k => lower.includes(k))) { await msg.reply(m.reply); if (chat) chat.clearState(); scheduleIdleReminder(chatId); return; } }

    // Kargo/takip soruları
    const isCargoAsk = /\bkargo(m|)\b|\btakip\b|\bnerde\b|\bnerede\b|\bne zaman gelir\b/i.test(lower);
    if (isCargoAsk) {
      if (!sess.order) await msg.reply('Sistemde tamamlanmış bir siparişiniz görünmüyor. Onay sonrası “EVET” yazmış olmanız gerekir.');
      else if (sess.order.status === 'hazirlaniyor') await msg.reply('Siparişiniz hazırlanıyor, kargoya verildiğinde bilgilendirileceksiniz.');
      else if (sess.order.status === 'kargoda') await msg.reply('Siparişiniz kargoda. Tahmini teslim 2–5 iş günü.');
      else if (sess.order.status === 'teslim') await msg.reply('Siparişiniz teslim edilmiş görünüyor. Sorun varsa yazın.');
      else if (sess.order.status === 'iptal') await msg.reply('Son siparişiniz iptal. Yeniden oluşturmak isterseniz yazın.');
      if (chat) chat.clearState();
      scheduleIdleReminder(chatId);
      return;
    }

    // SSS (debounce)
    if (Date.now() - (sess.lastFaqAt||0) > 30_000) {
      for (const f of faqMap) {
        if (f.regex.test(lower)) {
          sess.lastFaqAt = Date.now();
          await msg.reply(f.reply);
          const miss = missingFields(sess.data);
          if (miss.length) await msg.reply(buildReminderTextTR(miss));
          break; // akış devam
        }
      }
    }

    // Tüm alanlar tamamsa özet
    if (hasAll(sess.data) && !sess.order){
      await msg.reply(summaryText(sess.data));
      sess.stopReminders = true;
      if (chat) chat.clearState();
      return;
    }

    // AI cevabı
    let reply = await askAI(chatId, text);
    reply = (reply||'').trim();
    if (!reply){ const miss = missingFields(sess.data); reply = miss.length ? buildReminderTextTR(miss) : summaryText(sess.data); }
    if (reply) await msg.reply(reply);
    if (chat) chat.clearState();
    scheduleIdleReminder(chatId);
  }
  catch (err) {
    console.error('❌ Hata:', err);
    try { await msg.reply('Üzgünüz, geçici bir hata oluştu. Lütfen tekrar deneyin.'); } catch {}
  }
});

// -------------------- Express (QR/Health) --------------------
const app = express();
app.get('/qr', async (_req, res) => {
  try {
    if (!lastQr) return res.status(404).send('QR hazır değil.');
    res.setHeader('Content-Type', 'image/png');
    const png = await QRCode.toBuffer(lastQr, { width: 360, margin: 1 });
    res.end(png);
  } catch (e) { res.status(500).send('QR oluşturulamadı.'); }
});
app.get('/', (_req, res) => res.send('WhatsApp AI bot aktiv ✅'));
app.listen(PORT, () => console.log(`HTTP portu: ${PORT}`));

// -------------------- Start --------------------
client.initialize();
process.on('SIGINT', ()=>process.exit(0));
process.on('SIGTERM', ()=>process.exit(0));
