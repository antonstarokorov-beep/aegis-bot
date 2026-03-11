import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initializeApp } from 'firebase/app';
import { 
    getFirestore, 
    collection, 
    addDoc, 
    doc, 
    setDoc, 
    getDoc, 
    updateDoc, 
    onSnapshot 
} from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK SERVER (Для Render) ---
const app = express();
app.get('/', (req, res) => res.send('Aegis AI Bot: Online'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[SYSTEM] Мониторинг на порту ${PORT}`));

// --- 2. КОНФИГУРАЦИЯ ---
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app';

// Инициализация Telegram
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Защита от 409 Conflict
bot.on('polling_error', (error) => {
    if (error.message.includes('409 Conflict')) {
        console.warn('[RETRY] Конфликт соединений. Ожидание 10с...');
        bot.stopPolling();
        setTimeout(() => bot.startPolling(), 10000);
    }
});

// Инициализация Gemini (Исправлено для предотвращения 404)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Инициализация Firebase
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

const SYSTEM_PROMPT = `Ты — ИИ-ассистент юридической компании "ИДЖИС". 
Твоя цель: вежливо консультировать клиентов по списанию долгов и банкротству. 
Отвечай кратко (до 3 предложений). Спрашивай сумму долга.`;

// --- 3. ЛОГИКА ТЕЛЕГРАМ ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    console.log(`[TG] Сообщение от ${chatId}: ${text}`);

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        const leadData = leadSnap.exists() ? leadSnap.data() : null;

        // Сохраняем сообщение пользователя
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId,
            sender: 'user',
            text: text,
            timestamp: Date.now()
        });

        // Создаем/обновляем лида
        await setDoc(leadRef, {
            name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
            username: msg.from.username || 'n/a',
            updatedAt: Date.now(),
            status: leadData?.status || 'ai_active'
        }, { merge: true });

        // Если в чате оператор — бот не отвечает
        if (leadData?.status === 'operator_active') return;

        bot.sendChatAction(chatId, 'typing');
        
        // Ответ ИИ
        const result = await aiModel.generateContent(`${SYSTEM_PROMPT}\n\nКлиент: ${text}\nАссистент:`);
        const aiResponse = result.response.text();

        await bot.sendMessage(chatId, aiResponse);

        // Сохраняем ответ ИИ
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId,
            sender: 'ai',
            text: aiResponse,
            timestamp: Date.now()
        });

        // Саммари
        const sumResult = await aiModel.generateContent(`Краткое резюме проблемы одним предложением: ${text}`);
        await updateDoc(leadRef, {
            summary: sumResult.response.text()
        });

    } catch (err) {
        console.error("[ERROR] Ошибка бота:", err.message);
    }
});

// --- 4. ПЕРЕСЫЛКА ИЗ CRM ---
onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        if (change.type === 'added') {
            const m = change.doc.data();
            if (m.sender === 'operator') {
                bot.sendMessage(m.chatId, m.text).catch(e => {
                    if (!e.message.includes('409')) console.error("Ошибка пересылки:", e.message);
                });
            }
        }
    });
});

console.log(`[READY] Aegis AI Bot запущен. Sync ID: ${CRM_APP_ID}`);
