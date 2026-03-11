import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK (БУДИЛЬНИК) ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Pro Bot: Online'));
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

// Настройка DeepSeek
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1', 
    apiKey: process.env.DEEPSEEK_API_KEY,
    timeout: 15000, 
    maxRetries: 2   
});

// Настройка Firebase
const fbConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

const fbApp = initializeApp(fbConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

signInAnonymously(auth).catch(e => console.error("Firebase Auth Error:", e));

// --- 3. ПРОМПТ (ЛОГИКА БОТА) ---
const SYSTEM_PROMPT = `Ты — живой, опытный и вежливый юрист-консультант компании "ИДЖИС". 
Твоя задача — проконсультировать клиента по списанию долгов (банкротству) и квалифицировать его.

ПРАВИЛА ДИАЛОГА:
1. НИКОГДА не говори, что ты бот, ИИ или искусственный интеллект. Веди себя как настоящий человек.
2. Не задавай больше одного вопроса за раз. Веди диалог плавно.
3. Отвечай коротко: 1-2 предложения максимум. Никаких простыней текста.
4. Узнай: общую сумму долга и есть ли ипотека.
5. Если клиент пишет номер телефона, скажи: "Отлично, передал номер профильному юристу, он скоро вам наберет!" и больше не задавай вопросов.`;

// --- 4. TELEGRAM LOGIC ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text || text.startsWith('/')) return;

    console.log(`[TG] Сообщение от ${chatId}: ${text}`);

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;

        // Сохраняем сообщение клиента
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
        });

        // 1. АНАЛИЗ ТЕЛЕФОНА (Сохраняем в профиль)
        const phoneRegex = /(?:\+7|8|7)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/;
        const phoneMatch = text.match(phoneRegex);
        let updatedPhone = leadData?.phone || null;
        if (phoneMatch) {
            updatedPhone = phoneMatch[0];
        }

        let currentStatus = leadData?.status || 'ai_active';

        // 2. АВТО-ПРОБУЖДЕНИЕ (5 МИНУТ)
        if (currentStatus === 'operator_active') {
            const timeSinceLastUpdate = Date.now() - (leadData?.updatedAt || 0);
            if (timeSinceLastUpdate > 5 * 60 * 1000) {
                currentStatus = 'ai_active';
                console.log(`[SYSTEM] Бот проснулся для чата ${chatId}`);
            } else {
                // Если оператор еще ведет диалог, просто обновляем данные и молчим
                await updateDoc(leadRef, { updatedAt: Date.now(), phone: updatedPhone });
                return;
            }
        }

        // Обновляем карточку лида
        await setDoc(leadRef, {
            name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
            username: msg.from.username || 'n/a',
            updatedAt: Date.now(),
            status: currentStatus,
            phone: updatedPhone
        }, { merge: true });

        bot.sendChatAction(chatId, 'typing');

        // 3. БЕЗГРАНИЧНАЯ ПАМЯТЬ (Берем весь диалог)
        const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
        const chatHistory = allMsgsSnap.docs
            .map(d => d.data())
            .filter(m => m.chatId === chatId)
            .sort((a, b) => a.timestamp - b.timestamp); 

        let apiMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        chatHistory.forEach(m => {
            if (m.text) {
                apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text });
            }
        });

        // Генерируем ответ нейросети
        let aiResponse = "";
        try {
            const completion = await openai.chat.completions.create({
                messages: apiMessages,
                model: "deepseek-chat",
            });
            aiResponse = completion.choices[0].message.content;
        } catch (aiError) {
            console.error(`[DEEPSEEK ERROR]: ${aiError.message}`);
            aiResponse = "Извините, сейчас много обращений. Минутку, профильный юрист скоро ответит вам лично!";
        }

        // Отправляем ответ в ТГ и базу
        await bot.sendMessage(chatId, aiResponse);
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'ai', text: aiResponse, timestamp: Date.now()
        });

        // 4. УМНОЕ САММАРИ (Строго 2-4 слова)
        try {
            const userTexts = chatHistory.filter(m => m.sender === 'user').map(m => m.text).join('. ');
            const summaryCompletion = await openai.chat.completions.create({
                messages: [{ 
                    role: "user", 
                    content: `Прочитай текст и выдели суть проблемы строго в 2-4 слова. НИКАКИХ вводных слов. Пример: "Долг 500к, ипотека" или "Коллекторы угрожают". Текст: ${userTexts}` 
                }],
                model: "deepseek-chat",
            });
            const cleanSummary = summaryCompletion.choices[0].message.content.replace(/["']/g, '');
            await updateDoc(leadRef, { summary: cleanSummary });
        } catch(e) {}

    } catch (err) {
        console.error("[FATAL ERROR]:", err.message);
    }
});

// --- 5. CRM СИНХРОНИЗАЦИЯ (Отправка сообщений от оператора) ---
// Если кто-то пишет из веб-интерфейса CRM, бот пересылает это клиенту в Телеграм
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

console.log(`[SYSTEM] Aegis Pro Bot is running. Sync: ${CRM_APP_ID}`);