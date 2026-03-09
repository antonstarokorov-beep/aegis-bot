require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const { 
    getFirestore, 
    collection, 
    addDoc, 
    doc, 
    setDoc, 
    getDoc, 
    updateDoc, 
    onSnapshot 
} = require('firebase/firestore');
const express = require('express');

// --- 1. ИНИЦИАЛИЗАЦИЯ EXPRESS (для Render) ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot is Alive!'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Мониторинг запущен на порту ${PORT}`));

// --- 2. ПРОВЕРКА КЛЮЧЕЙ ---
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app';
if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.GEMINI_API_KEY) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА: Токены не заданы в Environment Variables!");
}

// --- 3. ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

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
Твоя цель: вежливо консультировать клиентов по банкротству физлиц. 
Отвечай кратко (до 3-4 предложений). 
В конце старайся подвести к тому, чтобы клиент оставил свой вопрос или записался на консультацию.`;

// --- 4. ОБРАБОТКА СООБЩЕНИЙ ИЗ TELEGRAM ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    console.log(`[TG] Новое сообщение от ${chatId}: ${text}`);

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        const leadData = leadSnap.exists() ? leadSnap.data() : null;

        // Сохраняем сообщение пользователя в историю
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId,
            sender: 'user',
            text: text,
            timestamp: Date.now()
        });

        // Создаем или обновляем лида
        await setDoc(leadRef, {
            name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
            username: msg.from.username || 'n/a',
            updatedAt: Date.now(),
            status: leadData?.status || 'ai_active'
        }, { merge: true });

        // Если оператор уже перехватил чат - ИИ не отвечает
        if (leadData?.status === 'operator_active') {
            console.log(`[AI] Пропуск ответа: в чате ${chatId} активен оператор.`);
            return;
        }

        // Генерируем ответ ИИ
        bot.sendChatAction(chatId, 'typing');
        
        const prompt = `${SYSTEM_PROMPT}\n\nКлиент: ${text}\nАссистент:`;
        const result = await aiModel.generateContent(prompt);
        const aiResponse = result.response.text();

        // Отправляем в Telegram
        await bot.sendMessage(chatId, aiResponse);

        // Сохраняем ответ ИИ в базу
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId,
            sender: 'ai',
            text: aiResponse,
            timestamp: Date.now()
        });

        // Генерируем саммари (фоном)
        const sumPrompt = `Сделай краткое резюме ситуации клиента (одна фраза): ${text}`;
        const sumResult = await aiModel.generateContent(sumPrompt);
        await updateDoc(leadRef, {
            summary: sumResult.response.text()
        });

    } catch (err) {
        console.error("[ERROR] Ошибка в основном цикле бота:", err.message);
        // Если это ошибка API ключа Gemini, мы увидим её здесь
    }
});

// --- 5. ПЕРЕСЫЛКА ОТВЕТОВ ИЗ CRM В TELEGRAM ---
const messagesRef = collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages');
let isInitialLoad = true;

onSnapshot(messagesRef, (snapshot) => {
    if (isInitialLoad) {
        isInitialLoad = false;
        return;
    }

    snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
            const data = change.doc.data();
            // Если сообщение от оператора — шлем в ТГ
            if (data.sender === 'operator') {
                console.log(`[CRM] Ответ оператора для ${data.chatId}: ${data.text}`);
                bot.sendMessage(data.chatId, data.text).catch(e => console.error("Ошибка пересылки оператора:", e.message));
            }
        }
    });
}, (err) => console.error("[ERROR] Ошибка подписки Firestore:", err.message));

console.log("Aegis AI Bot v4.3 запущен и готов к работе.");