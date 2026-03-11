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
// Берем ID из твоего .env файла (aegis-leads-app)
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Защита от конфликта 409
bot.on('polling_error', (err) => {
    if (err.message.includes('409 Conflict')) {
        console.warn('[SYSTEM] Конфликт 409: Бот запущен на ПК и на Render одновременно! Выключите одну из копий.');
        bot.stopPolling();
        setTimeout(() => bot.startPolling(), 10000);
    }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// ИСПРАВЛЕНИЕ 404: Добавлено "-latest" к названию модели
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

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

        // Сохраняем сообщение пользователя
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
        });

        // Создаем лида
        await setDoc(leadRef, {
            name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
            username: msg.from.username || 'n/a',
            updatedAt: Date.now(),
            status: leadData?.status || 'ai_active'
        }, { merge: true });

        // Если в чате юрист — бот молчит
        if (leadData?.status === 'operator_active') return;

        bot.sendChatAction(chatId, 'typing');
        
        // Генерация ответа через Gemini
        const result = await aiModel.generateContent(`${SYSTEM_PROMPT}\n\nКлиент: ${text}\nАссистент:`);
        const aiResponse = result.response.text();

        // Отправка клиенту
        await bot.sendMessage(chatId, aiResponse);

        // Лог ответа в базу
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'ai', text: aiResponse, timestamp: Date.now()
        });

        // Саммари (краткая суть для списка)
        const summaryRes = await aiModel.generateContent(`Краткое резюме проблемы одним предложением: ${text}`);
        await updateDoc(leadRef, { summary: summaryRes.response.text() });

    } catch (err) {
        console.error("[ERROR] Gemini logic failed:", err.message);
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

console.log(`[SYSTEM] Aegis AI Bot is running. Syncing with CRM ID: ${CRM_APP_ID}`);