import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis AI Bot: Online'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[SYSTEM] Monitoring on port ${PORT}`));

// --- 2. CONFIG ---
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Защита от конфликта 409
bot.on('polling_error', (err) => {
    if (err.message.includes('409 Conflict')) {
        console.warn('[SYSTEM] Конфликт 409: Выключите локальную копию бота.');
        bot.stopPolling();
        setTimeout(() => bot.startPolling(), 10000);
    }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Возвращаем самую умную и быструю модель
const MODEL_NAME = "gemini-1.5-flash";
const aiModel = genAI.getGenerativeModel({ model: MODEL_NAME });

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

        if (leadData?.status === 'operator_active') return;

        bot.sendChatAction(chatId, 'typing');
        
        // Попытка получить ответ от ИИ
        let aiResponse = "";
        try {
            const result = await aiModel.generateContent(`${SYSTEM_PROMPT}\n\nКлиент: ${text}\nАссистент:`);
            aiResponse = result.response.text();
        } catch (aiError) {
            console.error("[GOOGLE AI ERROR]:", aiError.message);
            // Если Google блокирует запрос (404 или другая ошибка), бот не зависнет!
            aiResponse = "Извините, сейчас ИИ-ассистент недоступен (ошибка ключа Google). Но ваше сообщение уже передано живому юристу, ожидайте ответа!";
        }

        await bot.sendMessage(chatId, aiResponse);

        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'ai', text: aiResponse, timestamp: Date.now()
        });

        // Саммари (игнорируем ошибку ИИ, чтобы не ломать логику)
        try {
            const summaryRes = await aiModel.generateContent(`Резюме проблемы одним предложением: ${text}`);
            await updateDoc(leadRef, { summary: summaryRes.response.text() });
        } catch(e) {}

    } catch (err) {
        console.error("[FATAL ERROR]:", err.message);
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

console.log(`[SYSTEM] Aegis AI Bot is running. Model: ${MODEL_NAME}. Sync: ${CRM_APP_ID}`);