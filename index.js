import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import 'dotenv/config';
import OpenAI from 'openai';
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Client({
    authStrategy: new LocalAuth()
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// QR kod çıktısı
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
});

// Bağlantı sağlanınca
client.on('ready', () => {
    console.log('WhatsApp bot hazır ✅');
});

// Mesaj geldiğinde
client.on('message', async msg => {
    console.log(`📩 Mesaj geldi: ${msg.body}`);

    // Burada AI cevabı üretiyoruz
    const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
            { role: "system", content: "Sen Romanya'da ayakkabı satışı yapan bir müşteri temsilcisisin. Kapıda ödeme, kargo süresi, ürün bilgisi sorularına net cevap ver." },
            { role: "user", content: msg.body }
        ]
    });

    const aiReply = response.choices[0].message.content;
    msg.reply(aiReply);
});

// Railway test endpoint
app.get('/', (req, res) => res.send('Bot çalışıyor ✅'));
app.listen(PORT, () => console.log(`Server ${PORT} portunda çalışıyor`));

client.initialize();
