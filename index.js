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
const sessions = new Map();   // chatId -> { muted, history, stopReminders, missingFields }
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

// --- Hızlı SSS (TR tetik / RO yanıt) ---
const faqMap = [
  { keys: ['fiyat','ucret','ücret','price','preț'], reply: 'Prețuri: 1 pereche 179,90 LEI; 2 perechi 279,90 LEI. Transport gratuit, plată la livrare.' },
  { keys: ['iade','geri','return','retur'],       reply: 'Retur în 14 zile calendaristice. Produs neutilizat și ambalaj intact.' },
  { keys: ['teslim','kargo','ne zaman','kaç günde','zaman','livrare','cât durează'], reply: 'Livrarea durează 7–10 zile lucrătoare. Transport gratuit.' },
  { keys: ['iban','havale','eft','banka','transfer'], reply: 'Plata la livrare (COD). Transfer bancar nu este necesar.' },
  { keys: ['site','website','link','adres'],       reply: 'Site-ul nostru: https://pellvero.com/' },
];

// --- Kimlik soruları (bot musun / insan mısın) kısa yanıtları ---
const identityMap = [
  { keys: ['bot musun','robot','yapay zek','ai misin','insan mısın','eşti bot','esti bot','ești om','esti om','sunteți om'],
    reply: 'Sunt asistent virtual al magazinului. Îți răspund rapid și politicos, iar dacă e nevoie te pot conecta la un operator uman.' }
];

// --- yardımcılar ---
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

// AI’dan gelen metindeki [MISSING: ...] etiketini oku
function extractMissing(reply) {
  const m = reply.match(/\[MISSING:([^\]]+)\]\s*$/i);
  if (!m) return null;
  const keys = m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return keys;
}

// RO hatırlatma metni üret (yalnız eksikleri iste)
const labels = {
  nume: 'numele complet (prenume + nume)',
  adresa: 'adresa completă (stradă, număr, apartament, oraș/județ)',
  cod_postal: 'COD POȘTAL',
  marime: 'mărimea (EU 40–44)',
  culoare: 'culoarea (negru/maro)',
  cantitate: 'cantitatea (1 sau 2)'
};
function roJoin(keys) {
  const arr = keys.map(k => labels[k] || k);
  if (arr.length <= 1) return arr[0] || '';
  return arr.slice(0, -1).join(', ') + ' și ' + arr.slice(-1);
}
function buildReminderText(missing) {
  const ks = missing.filter(k => k !== 'none');
  if (!ks.length) {
    return 'Doriți să finalizăm comanda? Spuneți-mi dacă doriți să confirmăm detaliile.';
  }
  // Özel kısaltma: sadece culoare+cantitate kaldıysa daha net yaz
  const onlyColorQty = ks.length === 2 && ks.includes('culoare') && ks.includes('cantitate');
  if (onlyColorQty) {
    return 'Te rog să confirmi culoarea (negru sau maro) și cantitatea (1 sau 2). Mulțumesc!';
  }
  return `Te rog să îmi oferi ${roJoin(ks)}. Mulțumesc!`;
}

// --- 1 dk idle hatırlatma ---
function scheduleIdleReminder(chatId) {
  clearTimeout(idleTimers.get(chatId));
  const t = setTimeout(async () => {
    try {
      const sess = sessions.get(chatId);
      if (!sess || sess.muted || sess.stopReminders) return;
      const msgText = buildReminderText(Array.isArray(sess.missingFields) ? sess.missingFields : ['nume','adresa','cod_postal','marime','culoare','cantitate']);
      await client.sendMessage(chatId, msgText);
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

REGULI STRICTE:
1) NU cere telefon în mod activ. Primești în context "Număr WhatsApp". Dacă clientul oferă un număr nou în text, FOLOSEȘTE acel număr în locul celui din WhatsApp și confirmă: "Notez acest număr pentru livrare."
2) Numele trebuie să fie NUME COMPLET: **prenume + nume** (minim două cuvinte). Dacă primești un singur cuvânt, cere politicos numele complet.
3) Adresa TREBUIE să conțină: stradă, număr, apartament (dacă există), **COD POȘTAL**, oraș/județ. Dacă lipsește ceva, cere FIX acel detaliu; nu repeta ce avem deja.
4) Mărime: DOAR EU **40–44** (nu alte valori). Acceptă "40 44" sau "42,43" stilinde şi clarifică pentru fiecare pereche la nevoie.
5) Culori: DOAR **negru** sau **maro**.
6) Cantitate: **1** sau **2**. Dacă este 2, cere clar **două culori** (pot fi identice) şi/sau două mărimi dacă clientul a dat două mărimi.
7) Clientul poate scrie amestecat (ex: "2 43 negru"). Înțelege și extrage.
8) NU trimite rezumatul până nu ai simultan: nume complet, adresă completă, mărime, culoare(-i) și cantitate. Spune explicit ce lipsește (doar lipsa).
9) Rezumatul final va include: nume, adresă, **telefonul ales**, perechi, mărime, culoare(-i), total (1=179,90 LEI; 2=279,90 LEI), livrare 7–10 zile, transport gratuit. Cere confirmare cu «DA» sau «MODIFIC».
10) La întrebări generale (preț, livrare, retur, IBAN) răspunde întâi scurt, apoi readu discuția către plasarea comenzii cu lista scurtă de câmpuri lipsă.

FORMAT TEHNIC OBLIGATORIU:
- La FINALUL fiecărui răspuns, adaugă o linie doar pentru sistem în acest format exact:
  [MISSING: nume,adresa,cod_postal,marime,culoare,cantitate]
  • Include DOAR câmpurile care lipsesc; dacă nu lipsește nimic, scrie: [MISSING: none]
- Nu face referire la această linie în textul pentru client.
`.trim();

    sessions.set(chatId, {
      muted: false,
      history: [{ role: 'system', content: systemPrompt }],
      stopReminders: false,
      // başlangıçta her şey eksik varsay
      missingFields: ['nume','adresa','cod_postal','marime','culoare','cantitate']
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

  let reply = res.choices?.[0]?.message?.content || '';
  // 1) MISSING etiketini oku ve state'e yaz
  const missing = extractMissing(reply);
  if (missing && missing.length) {
    sess.missingFields = missing;
  }
  // 2) Bu meta satırı müşteriye gösterme
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

    // Sadece "DA" onayı gelince dürtmeyi kalıcı kes
    if (/^\s*da\s*$/i.test(text)) {
      sess.stopReminders = true;
      clearTimeout(idleTimers.get(chatId));
    }

    // Kontrol komutları
    if (lower === 'operator') {
      sess.muted = true;
      await msg.reply('Vă conectăm cu un operator. Mulțumim!');
      return;
    }
    if (lower === 'bot') {
      sess.muted = false;
      sess.stopReminders = false; // bot yeniden açıldı → dürtmeler tekrar aktif
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
        if (!sessions.get(chatId).stopReminders) scheduleIdleReminder(chatId);
        return;
      }
    }

    // SSS (önce)
    for (const f of faqMap) {
      if (f.keys.some(k => lower.includes(k))) {
        await msg.reply(f.reply);
        await msg.reply('Doriți să continuăm cu plasarea comenzii? Vă rog numele complet (prenume + nume), adresa, mărimea (EU 40–44), culoarea (negru/maro) și cantitatea (1 sau 2).');
        // SSS sonrası henüz alanlar yoksa default eksikler kalsın
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
