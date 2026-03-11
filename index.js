import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis AI Bot (DeepSeek Edition): Online'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[SYSTEM] Monitoring on port ${PORT}`));

// --- 2. CONFIG ---
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (err) => {
    if (err.message.includes('409 Conflict')) {
        console.warn('[SYSTEM] Конфликт 409: Выключите локальную копию.');
        bot.stopPolling();
        setTimeout(() => bot.startPolling(), 10000);
    }
});

// ИНИЦИАЛИЗАЦИЯ DEEPSEEK
// ИСПРАВЛЕНИЕ: Добавлен жесткий таймаут, чтобы бот не "зависал" при перегрузке серверов ИИ
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1', 
    apiKey: process.env.DEEPSEEK_API_KEY,
    timeout: 15000, // Максимальное время ожидания ответа: 15 секунд
    maxRetries: 2   // Попробовать еще 2 раза, если произошел сбой сети
});

const fbConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

const fbApp = initializeApp(fbConfig);
const db = getFirestore(fbApp);

const SYSTEM_PROMPT = `Ты — ИИ-юрист компании "ИДЖИС". 
Твоя цель: вежливо консультировать клиентов по банкротству. 
Отвечай кратко (до 3 предложений). Спрашивай сумму долга.`;

// --- 3. TELEGRAM LOGIC ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    console.log(`[TG] Message from ${chatId}: ${text}`);

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        const leadData = leadSnap.exists() ? leadSnap.data() : null;

        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
        });

        await setDoc(leadRef, {
            name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
            username: msg.from.username || 'n/a',
            updatedAt: Date.now(),
            status: leadData?.status || 'ai_active'
        }, { merge: true });

        // Если в чате юрист — бот молчит
        if (leadData?.status === 'operator_active') return;

        bot.sendChatAction(chatId, 'typing');
        
        let aiResponse = "";
        try {
            // Запрос к DeepSeek
            const completion = await openai.chat.completions.create({
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: text }
                ],
                model: "deepseek-chat",
            });
            aiResponse = completion.choices[0].message.content;
            
        } catch (aiError) {
            console.error(`[DEEPSEEK AI ERROR]: Status ${aiError.status || 'TIMEOUT'} - ${aiError.message}`);
            aiResponse = "Извините, серверы ИИ сейчас перегружены. Ваше сообщение передано живому юристу, ожидайте ответа!";
        }

        // Отправка ответа пользователю
        await bot.sendMessage(chatId, aiResponse);

        // Сохранение ответа в CRM
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'ai', text: aiResponse, timestamp: Date.now()
        });

        // Генерация краткого резюме для CRM
        try {
            const summaryCompletion = await openai.chat.completions.create({
                messages: [{ role: "user", content: `Краткое резюме проблемы одним предложением: ${text}` }],
                model: "deepseek-chat",
            });
            await updateDoc(leadRef, { summary: summaryCompletion.choices[0].message.content });
        } catch(e) {} // Ошибку саммари игнорируем тихо

    } catch (err) {
        console.error("[FATAL ERROR]:", err.message);
        // Если база данных упала, всё равно пытаемся ответить клиенту
        bot.sendMessage(chatId, "Произошла системная ошибка, но мы получили ваше сообщение.").catch(() => {});
    }
});

// --- 4. CRM SYNC ---
onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        if (change.type === 'added') {
            const m = change.doc.data();
            if (m.sender === 'operator') {
                bot.sendMessage(m.chatId, m.text).catch(() => {});
            }
        }
    });
});

console.log(`[SYSTEM] Aegis AI Bot is running. Model: DeepSeek. Sync: ${CRM_APP_ID}`);