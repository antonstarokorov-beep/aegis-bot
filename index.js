import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK & EXPRESS SERVER ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Stable Edition): Online'));
const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => console.log(`[SYSTEM] Monitoring active on 0.0.0.0:${PORT}`));

// --- 2. CONFIG ---
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app';
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
});

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

const BASE_PROMPT = `Ты — Антон Старокоров, арбитражный управляющий. Эксперт, фильтр кейсов.

ТОН: Сухой, уверенный.
ПРАВИЛА:
1. Обязательно здоровайся (Здравствуйте/Приветствую).
2. Оскорбления = "Диалог окончен." (игнор навсегда).
3. Избегай шаблонов. Каждый раз перефразируй вопросы.
4. Веди по воронке: Долг (>500к), Активы, Сделки, Соц.статус, Цели.
5. Если телефон есть в базе - НЕ ПРОСИ.

ГОЛОС [VOICE]:
- Только утверждения.
- ЗАПРЕЩЕНО слово "приставы" (заменяй на ФССП).
- ЗАПРЕЩЕНО называть цифры.`;

function numberToWords(num) {
    const map = { '15': 'пятнадцати', '10': 'десяти', '20': 'двадцати', '30': 'тридцати', '5': 'пяти' };
    return map[num] || num;
}

function cleanTextForTTS(text) {
    return text
        .replace(/\?/g, '.')
        .replace(/пристав[а-я]*/gi, 'сотрудники ФССП')
        .replace(/\d{5,}/g, ' ') 
        .replace(/\b(15|10|20|30|5)\b/g, (m) => numberToWords(m))
        .replace(/\s+/g, ' ') 
        .trim();
}

async function generateVoice(text) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) return null;
    const cleanText = cleanTextForTTS(text);
    try {
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanText, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
        });
        if (!response.ok) {
            const errData = await response.json();
            console.error("[ELEVENLABS ERROR]:", errData.detail?.status);
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) { return null; }
}

bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    let text = msg.text || "";
    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;

        if (text.startsWith('/')) {
            if (text === '/start') {
                await setDoc(leadRef, { name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''), username: msg.from.username || 'n/a', updatedAt: Date.now(), status: 'ai_active' }, { merge: true });
                bot.sendMessage(chatId, "Здравствуйте. Я Антон Старокоров, арбитражный управляющий. Уточните вашу общую сумму долга?");
            }
            if (text === '/reset') {
                await setDoc(leadRef, { resetAt: Date.now(), status: 'ai_active', updatedAt: Date.now() }, { merge: true });
                bot.sendMessage(chatId, "Память ИИ очищена. Блокировки сняты. Можем продолжать.");
            }
            return;
        }

        if (leadData?.status === 'closed') {
            console.log(`[IGNORE] User ${chatId} is in CLOSED status.`);
            return;
        }

        const configRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'config', 'bot_settings');
        const configSnap = await getDoc(configRef);
        const dynamicInstructions = configSnap.exists() ? configSnap.data().instructions : "";

        if (leadData?.status === 'operator_active' && (Date.now() - (leadData?.updatedAt || 0) < 5 * 60 * 1000)) {
            console.log(`[IGNORE] Operator is active for ${chatId}`);
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { chatId: chatId, sender: 'user', text: text, timestamp: Date.now() });
            return;
        }

        const phoneMatch = text.match(/(?:\+?\d[\s\-()]?){10,14}/g);
        let phoneToSave = leadData?.phone || (phoneMatch ? phoneMatch[0] : null);

        await setDoc(leadRef, { phone: phoneToSave, updatedAt: Date.now() }, { merge: true });
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { chatId: chatId, sender: 'user', text: text, timestamp: Date.now() });

        const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
        const chatHistory = allMsgsSnap.docs
            .map(d => d.data())
            .filter(m => m.chatId === chatId && m.timestamp >= (leadData?.resetAt || 0))
            .sort((a, b) => a.timestamp - b.timestamp);

        let finalPrompt = BASE_PROMPT;
        if (dynamicInstructions) finalPrompt += `\n\nДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n${dynamicInstructions}`;
        if (phoneToSave) finalPrompt += `\nИНФО: Телефон клиента уже есть: ${phoneToSave}. НЕ ПРОСИ ЕГО.`;

        let apiMessages = [{ role: "system", content: finalPrompt }];
        chatHistory.forEach(m => { if (m.text && !m.text.includes('🔊')) apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text }); });

        const completion = await openai.chat.completions.create({ messages: apiMessages, model: "deepseek-chat" });
        const aiResponse = completion.choices[0].message.content;

        if (aiResponse.includes("Диалог окончен")) {
            await updateDoc(leadRef, { status: 'closed' });
            bot.sendMessage(chatId, "Диалог окончен.");
            return;
        }

        const parts = aiResponse.split('[VOICE]');
        const textPart = parts[0]?.trim();
        const voicePart = parts[1]?.trim();

        if (textPart) {
            bot.sendChatAction(chatId, 'typing');
            await new Promise(r => setTimeout(r, Math.min(Math.max(textPart.length * 60, 4000), 10000)));
            await bot.sendMessage(chatId, textPart);
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { chatId: chatId, sender: 'ai', text: textPart, timestamp: Date.now() });
        }

        if (voicePart) {
            bot.sendChatAction(chatId, 'record_voice');
            const voiceBuffer = await generateVoice(voicePart);
            if (voiceBuffer) {
                await bot.sendVoice(chatId, voiceBuffer);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { chatId: chatId, sender: 'ai', text: `🔊 [Голос]: ${voicePart}`, timestamp: Date.now() });
            } else {
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { chatId: chatId, sender: 'ai', text: `⚠️ [ОШИБКА ГОЛОСА]: ${voicePart}`, timestamp: Date.now() });
            }
        }

        const sumRes = await openai.chat.completions.create({
            messages: [{ role: "user", content: `Выжимка (долг, активы, телефон: ${phoneToSave || 'нет'}) до 40 слов: ${text}` }],
            model: "deepseek-chat"
        });
        await updateDoc(leadRef, { summary: sumRes.choices[0].message.content });

    } catch (err) { console.error("Critical Bot Error:", err); }
});

onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        if (change.type === 'added' && change.doc.data().sender === 'operator') {
            bot.sendMessage(change.doc.data().chatId, change.doc.data().text).catch(() => {});
        }
    });
});