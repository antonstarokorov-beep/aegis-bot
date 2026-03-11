import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs, deleteDoc } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Sales Pro + Voice Debug): Online'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`[SYSTEM] Monitoring on port ${PORT}`));

// --- 2. CONFIG ---
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app';
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1', 
    apiKey: process.env.DEEPSEEK_API_KEY,
    timeout: 15000, 
    maxRetries: 2   
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
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

signInAnonymously(auth).catch(e => console.error("Firebase Auth Error:", e));

// --- 3. СУПЕР ПРОДАЖНИК (ПРОМПТ) ---
const SYSTEM_PROMPT = `Ты — ведущий эксперт по банкротству физических лиц. Ты не бот, ты профессионал. Твоя задача — закрыть клиента на телефонный звонок.

ТВОЙ СТИЛЬ:
- Уверенный, авторитетный. Пиши коротко.
- Используй фразы: "Ситуация понятная", "Смотрите, как мы поступим".

АЛГОРИТМ ПРОДАЖИ:
1. Узнай общую сумму долгов. 
2. Узнай про имущество или ипотеку.
3. Как только у тебя есть цифры, сделай оффер через голосовое.
   Чтобы отправить голосовое, ОБЯЗАТЕЛЬНО начни ответ со слова [VOICE].
   Пример: "[VOICE] Слушайте, ситуация рабочая. Давайте я вам сейчас наберу на 2 минуты, задам пару вопросов и точно скажу, какую сумму спишем. Вам удобнее сейчас или через полчаса? Напишите номер."`;

// --- ФУНКЦИЯ ELEVENLABS (С ПОДРОБНЫМ ЛОГИРОВАНИЕМ) ---
async function generateVoice(text) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    
    if (!apiKey || !voiceId) {
        console.error("[VOICE] Ошибка: Проверь ELEVENLABS_API_KEY и ELEVENLABS_VOICE_ID на Render!");
        return null;
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text: text,
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.8 }
            })
        });

        if (!response.ok) {
            // Читаем текст ошибки от ElevenLabs, чтобы понять что не так
            const errorText = await response.text();
            console.error(`[VOICE ERROR] Status: ${response.status}. Message: ${errorText}`);
            return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) {
        console.error("[VOICE FATAL ERROR]:", e.message);
        return null;
    }
}

// --- 4. TELEGRAM LOGIC ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text) return;

    // СЕРВИСНЫЕ КОМАНДЫ
    if (text.startsWith('/')) {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        if (text === '/start') {
            bot.sendMessage(chatId, "Добрый день! Я юрист компании ИДЖИС. Какая у вас общая сумма задолженности?");
            return;
        }
        if (text === '/debug_voice') {
            bot.sendMessage(chatId, "⏳ Проверка ElevenLabs... Секунду.");
            const testVoice = await generateVoice("Проверка связи. Как слышно?");
            if (testVoice) {
                await bot.sendVoice(chatId, testVoice);
                bot.sendMessage(chatId, "✅ Голос работает!");
            } else {
                bot.sendMessage(chatId, "❌ Ошибка. Проверь логи в панели Render.com (кнопка Logs).");
            }
            return;
        }
        if (text === '/reset') {
            const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
            const msgsToDelete = allMsgsSnap.docs.filter(d => d.data().chatId === chatId);
            for (const docSnap of msgsToDelete) await deleteDoc(doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages', docSnap.id));
            await setDoc(leadRef, { summary: "", phone: null, status: 'ai_active', updatedAt: Date.now() }, { merge: true });
            bot.sendMessage(chatId, "✨ История очищена.");
            return;
        }
        return;
    }

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;

        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
        });

        const phoneRegex = /(?:\+7|8|7)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/;
        const phoneMatch = text.match(phoneRegex);
        let updatedPhone = leadData?.phone || null;
        if (phoneMatch) updatedPhone = phoneMatch[0];

        let currentStatus = leadData?.status || 'ai_active';

        if (currentStatus === 'operator_active') {
            const timeSinceLastUpdate = Date.now() - (leadData?.updatedAt || 0);
            if (timeSinceLastUpdate > 5 * 60 * 1000) currentStatus = 'ai_active';
            else {
                await updateDoc(leadRef, { updatedAt: Date.now(), phone: updatedPhone });
                return;
            }
        }

        await setDoc(leadRef, {
            name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
            username: msg.from.username || 'n/a',
            updatedAt: Date.now(),
            status: currentStatus,
            phone: updatedPhone
        }, { merge: true });

        const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
        const chatHistory = allMsgsSnap.docs
            .map(d => d.data())
            .filter(m => m.chatId === chatId)
            .sort((a, b) => a.timestamp - b.timestamp); 

        let apiMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        chatHistory.forEach(m => {
            if (m.text) {
                const cleanText = m.text.replace('🔊 [Голосовое сообщение]: ', '');
                apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: cleanText });
            }
        });

        const completion = await openai.chat.completions.create({ messages: apiMessages, model: "deepseek-chat" });
        let aiResponse = completion.choices[0].message.content;

        const isVoiceMsg = aiResponse.includes('[VOICE]');
        const textToProcess = aiResponse.replace('[VOICE]', '').trim();
        bot.sendChatAction(chatId, isVoiceMsg ? 'record_voice' : 'typing');
        
        const delay = Math.min(Math.max(textToProcess.length * 80, 2500), 9000);
        await new Promise(r => setTimeout(r, delay));

        if (isVoiceMsg) {
            const voiceBuffer = await generateVoice(textToProcess);
            if (voiceBuffer) {
                await bot.sendVoice(chatId, voiceBuffer);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: `🔊 [Голосовое сообщение]: ${textToProcess}`, timestamp: Date.now()
                });
            } else {
                await bot.sendMessage(chatId, textToProcess);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: textToProcess, timestamp: Date.now()
                });
            }
        } else {
            await bot.sendMessage(chatId, textToProcess);
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'ai', text: textToProcess, timestamp: Date.now()
            });
        }

        try {
            const userTexts = chatHistory.filter(m => m.sender === 'user').map(m => m.text).join('. ');
            const sumComp = await openai.chat.completions.create({
                messages: [{ role: "user", content: `Сделай резюме ситуации клиента (долг, ипотека, доход, проблемы) до 50 слов. Текст: ${userTexts}` }],
                model: "deepseek-chat",
            });
            await updateDoc(leadRef, { summary: sumComp.choices[0].message.content });
        } catch(e) {}

    } catch (err) { console.error("[FATAL ERROR]:", err.message); }
});

onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        if (change.type === 'added' && change.doc.data().sender === 'operator') {
            bot.sendMessage(change.doc.data().chatId, change.doc.data().text).catch(() => {});
        }
    });
});