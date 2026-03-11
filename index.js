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
// Жестко фиксируем ID для синхронизации с CRM
const CRM_APP_ID = 'c_4e520df03c9fb749_src';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Защита от 409 Conflict
bot.on('polling_error', (err) => {
    if (err.message.includes('409 Conflict')) {
        console.warn('[RETRY] Conflict. Waiting 10s...');
        bot.stopPolling();
        setTimeout(() => bot.startPolling(), 10000);
    }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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

const SYSTEM_PROMPT = `Ты — юридический ассистент компании "ИДЖИС". 
Отвечай вежливо и кратко (2-3 предложения). Спрашивай сумму долга клиента.`;

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
        const result = await aiModel.generateContent(`${SYSTEM_PROMPT}\n\nКлиент: ${text}\nАссистент:`);
        const aiResponse = result.response.text();

        await bot.sendMessage(chatId, aiResponse);

        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'ai', text: aiResponse, timestamp: Date.now()
        });

        const sumRes = await aiModel.generateContent(`Summarize in 5 words: ${text}`);
        await updateDoc(leadRef, { summary: sumRes.response.text() });

    } catch (err) {
        console.error("[ERROR]", err.message);
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

console.log(`[READY] Aegis AI Bot running. ID: ${CRM_APP_ID}`);