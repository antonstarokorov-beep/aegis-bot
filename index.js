import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs, deleteDoc } from 'firebase/firestore';
import express from 'express';
import fetch from 'node-fetch';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Pro Edition + Commands): Online'));
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

// --- 3. ЛИЧНОСТЬ ---
const SYSTEM_PROMPT = `Ты — частный юрист и эксперт по списанию долгов. Твоя цель — квалифицировать клиента и вывести его на звонок.
Веди диалог от первого лица ("я понял", "посмотрим"). Ты общаешься в Telegram, поэтому пиши коротко, без сложных терминов.

ПРАВИЛА И ЭМПАТИЯ:
1. Ты живой человек. Используй фразы: "понимаю вас", "ситуация стандартная", "не переживайте".
2. В каждом сообщении делай небольшую логическую паузу или задавай только ОДИН простой вопрос.
3. Никогда не уговаривай. Если сомневаются, используй метод отталкивания: "Дело ваше, главное помните, что долг сам не исчезнет. Надумаете — пишите."

ВОРОНКА ПРОДАЖ:
Шаг 1. Аккуратно узнай общую сумму долга.
       - Если до 300к: "Слушайте, с такой суммой процедура может быть невыгодна. Но давайте я наберу, прикинем варианты. Оставьте номер."
Шаг 2. Узнай про ипотеку, доход или семейное положение (между делом).
Шаг 3. ВАЖНО: Как только узнал сумму и базовую ситуацию, отправь клиенту ГОЛОСОВОЕ сообщение. 
       Чтобы отправить голосовое, начни свой ответ со слова [VOICE], а дальше напиши текст, который нужно озвучить.
       Пример: "[VOICE] Слушайте, ситуация абсолютно рабочая. Давайте я вам сейчас наберу, задам пару вопросов и точно скажу, сколько спишем. Напишите свой номер."

ОТРАБОТКА ВОЗРАЖЕНИЙ:
- Гарантии/Цена: "Оплата зависит от сложности, гарантии прописываем в договоре. Консультация бесплатная. Оставьте номер, всё расскажу."`;

// --- ФУНКЦИЯ ELEVENLABS ---
async function generateVoice(text) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    
    if (!apiKey || !voiceId) return null;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                model_id: "eleven_multilingual_v2",
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
        });
        if (!response.ok) throw new Error("ElevenLabs API error");
        return await response.arrayBuffer();
    } catch (e) {
        console.error("Voice Gen Error:", e);
        return null;
    }
}

// --- 4. TELEGRAM LOGIC ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text) return;

    // ==========================================
    // БЛОК СКРЫТЫХ СЕРВИСНЫХ КОМАНД
    // ==========================================
    if (text.startsWith('/')) {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        
        if (text === '/start') {
            bot.sendMessage(chatId, "Здравствуйте! Я профильный юрист компании ИДЖИС. Какая у вас общая сумма долгов по кредитам и займам?");
            return;
        }
        if (text === '/id') {
            bot.sendMessage(chatId, `🔧 Ваш Telegram ID: ${chatId}\nCRM Sync ID: ${CRM_APP_ID}`);
            return;
        }
        if (text === '/pause') {
            await setDoc(leadRef, { status: 'operator_active', updatedAt: Date.now() }, { merge: true });
            bot.sendMessage(chatId, "⏸ ИИ поставлен на паузу. Бот больше не будет отвечать на ваши сообщения.");
            return;
        }
        if (text === '/resume') {
            await setDoc(leadRef, { status: 'ai_active', updatedAt: Date.now() }, { merge: true });
            bot.sendMessage(chatId, "▶️ ИИ активирован. Бот снова в деле.");
            return;
        }
        if (text === '/reset') {
            bot.sendMessage(chatId, "🔄 Очистка истории переписки...");
            try {
                const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
                const msgsToDelete = allMsgsSnap.docs.filter(d => d.data().chatId === chatId);
                
                for (const docSnap of msgsToDelete) {
                    await deleteDoc(doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages', docSnap.id));
                }
                
                await setDoc(leadRef, { summary: "", phone: null, status: 'ai_active', updatedAt: Date.now() }, { merge: true });
                bot.sendMessage(chatId, "✅ История полностью удалена. Напишите любое сообщение, чтобы начать заново.");
            } catch (err) {
                bot.sendMessage(chatId, "❌ Ошибка при удалении: " + err.message);
            }
            return;
        }
        return;
    }
    // ==========================================

    console.log(`[TG] Сообщение от ${chatId}: ${text}`);

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
            if (timeSinceLastUpdate > 5 * 60 * 1000) {
                currentStatus = 'ai_active';
            } else {
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

        // Читаем историю
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

        let aiResponse = "";
        try {
            const completion = await openai.chat.completions.create({
                messages: apiMessages,
                model: "deepseek-chat",
            });
            aiResponse = completion.choices[0].message.content;
        } catch (aiError) {
            aiResponse = "Слушайте, сейчас немного занят на заседании. Оставьте номер, наберу как освобожусь!";
        }

        const isVoiceMsg = aiResponse.includes('[VOICE]');
        const textToType = aiResponse.replace('[VOICE]', '').trim();
        
        bot.sendChatAction(chatId, isVoiceMsg ? 'record_voice' : 'typing');
        
        const typingDelay = Math.min(Math.max(textToType.length * 60, 2000), 8000); 
        await new Promise(resolve => setTimeout(resolve, typingDelay));

        if (isVoiceMsg) {
            const voiceBuffer = await generateVoice(textToType);
            if (voiceBuffer) {
                await bot.sendVoice(chatId, Buffer.from(voiceBuffer));
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: `🔊 [Голосовое сообщение]: ${textToType}`, timestamp: Date.now()
                });
            } else {
                await bot.sendMessage(chatId, textToType);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: textToType, timestamp: Date.now()
                });
            }
        } else {
            await bot.sendMessage(chatId, textToType);
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'ai', text: textToType, timestamp: Date.now()
            });
        }

        // ==========================================
        // ОБНОВЛЕННОЕ ПОЛНОЦЕННОЕ САММАРИ
        // ==========================================
        try {
            const userTexts = chatHistory.filter(m => m.sender === 'user').map(m => m.text).join('. ');
            if (userTexts.length > 5) {
                const summaryCompletion = await openai.chat.completions.create({
                    messages: [{ 
                        role: "user", 
                        content: `Составь информативное резюме ситуации клиента на основе его сообщений. Обязательно укажи ключевые факты (если они упоминались): общую сумму долга, наличие ипотеки или автокредита, семейное положение, официальный доход и текущую проблему (например, звонят коллекторы или просрочки). Пиши сухо, по делу, как аналитическую выжимку для старшего юриста. Строго не более 50 слов! Текст клиента: ${userTexts}` 
                    }],
                    model: "deepseek-chat",
                });
                await updateDoc(leadRef, { summary: summaryCompletion.choices[0].message.content.replace(/["']/g, '') });
            }
        } catch(e) {}

    } catch (err) {
        console.error("[FATAL ERROR]:", err.message);
    }
});

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