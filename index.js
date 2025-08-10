import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

client.on('qr', (qr) => {
  // Railway loglarında ASCII QR görünecek
  qrcode.generate(qr, { small: true });
  console.log('🔑 QR kodu çıktı, WhatsApp > Bağlı Cihazlar > Cihaz Bağla ile tara.');
});

client.on('ready', () => {
  console.log('✅ WhatsApp bot hazır');
});

client.on('message', async (msg) => {
  try {
    console.log(`📩 ${msg.from}: ${msg.body}`);

    const res = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'Sen Romanya için satış yapan bir müşteri temsilcisisin. Kapıda ödeme, kargo (7–10 zile lucrătoare), fiyat (1 pereche 179,90 LEI; 2 perechi 279,90 LEI; transport gratuit) bilgilerini biliyorsun. Müşteri sipariş vermek isterse sırasıyla nume complet, adresa completă, telefon, mărime, culoare iste. Kısa ve nazik cevap ver.' },
        { role: 'user', content: msg.body }
      ]
    });

    const reply = res.choices?.[0]?.message?.content?.trim() || 'Scuze, s-a produs o eroare temporară.';
    await msg.reply(reply);
  } catch (e) {
    console.error('AI error:', e);
    try { await msg.reply('Ne pare rău, a apărut o eroare. Încercați din nou.'); } catch {}
  }
});

app.get('/', (_, res) => res.send('WhatsApp AI bot aktif ✅'));
app.listen(PORT, () => console.log(`HTTP portu: ${PORT}`));

client.initialize();
