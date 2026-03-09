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
    onSnapshot,
    query,
    where
} = require('firebase/firestore');
const express = require('express');

// 1. Проверка переменных окружения
const requiredEnv = [
    'TELEGRAM_BOT_TOKEN', 
    'GEMINI_API_KEY', 
    'FIREBASE_API_KEY', 
    'FIREBASE_PROJECT_ID'
];
requiredEnv.forEach(key => {
    if (!process.env[key]) console.warn(`Внимание: Переменная ${key} не задана!`);
});

// 2. Инициализация Telegram и ИИ
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 3. Инициализация Firebase
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || "default-app-id"; 

// 4. Настройка моделей Gemini
const aiModel = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: `Ты опытный юрист по банкротству физических лиц компании "ИДЖИС". 
Твоя задача: вежливо консультировать, узнать сумму долга (если >300к - списание возможно), 
узнать о наличии имущества и ипотеки. 
Главная цель: получить номер телефона для передачи дела старшему юристу. 
Пиши кратко, по-человечески. Не используй сложные термины.`
});

const summaryModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Временное хранилище контекста (для саммари)
const chatContext = {};

// 5. Обработка сообщений из Telegram
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    if (!text) return;

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        
        // Если оператор уже в чате - ИИ не мешает
        if (leadSnap.exists() && leadSnap.data().status === 'operator_active') {
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId, sender: 'user', text, timestamp: Date.now()
            });
            return;
        }

        // Регистрация нового лида
        if (!chatContext[chatId]) {
            chatContext[chatId] = [];
            await setDoc(leadRef, {
                name: msg.from.first_name || 'Клиент',
                username: msg.from.username || '',
                status: 'ai_active',
                createdAt: Date.now(),
                phone: '',
                summary: 'Диалог начат...'
            }, { merge: true });
        }

        // Сохраняем входящее
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId, sender: 'user', text, timestamp: Date.now()
        });

        chatContext[chatId].push(`Клиент: ${text}`);

        // Ответ ИИ
        const chat = aiModel.startChat({ history: [] }); // Для простоты без глубокой истории в памяти
        const result = await chat.sendMessage(text);
        const aiText = result.response.text();

        await bot.sendMessage(chatId, aiText);
        chatContext[chatId].push(`ИИ: ${aiText}`);

        // Сохраняем ответ ИИ
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId, sender: 'ai', text: aiText, timestamp: Date.now()
        });

        // Проверка на телефон и создание саммари
        const phoneRegex = /(\+7|8)[\s(]?\d{3}[)\s]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/;
        if (phoneRegex.test(text)) {
            const sumPrompt = `Сделай краткое резюме для юриста по этому диалогу:\n${chatContext[chatId].join('\n')}`;
            const sumRes = await summaryModel.generateContent(sumPrompt);
            await updateDoc(leadRef, {
                phone: text.match(phoneRegex)[0],
                summary: sumRes.response.text()
            });
        }

    } catch (err) {
        console.error("Ошибка обработки ТГ:", err);
    }
});

// 6. Пересылка сообщений из CRM в Telegram (от Юриста)
const messagesRef = collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages');
let initial = true;
onSnapshot(messagesRef, (snap) => {
    if (initial) { initial = false; return; }
    snap.docChanges().forEach(change => {
        if (change.type === 'added') {
            const m = change.doc.data();
            if (m.sender === 'operator') {
                bot.sendMessage(m.chatId, m.text).catch(e => console.error("Ошибка пересылки:", e));
            }
        }
    });
});

// 7. Простейший веб-сервер для мониторинга (нужен для Render.com)
const appExpress = express();
appExpress.get('/', (req, res) => res.send('Aegis AI Bot is Online 🚀'));
const PORT = process.env.PORT || 3000;
appExpress.listen(PORT, () => console.log(`Мониторинг запущен на порту ${PORT}`));