import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs, deleteDoc } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Legal Pro): Online'));
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

// --- 3. ЛИЧНОСТЬ "АНТОН БОРИСОВИЧ" (ЮРИСТ-ЭКСПЕРТ) ---
const SYSTEM_PROMPT = `Ты — Антон Борисович, ведущий юрист по делам о несостоятельности (банкротстве). Твой стиль — профессиональный прагматизм.

ТВОЙ НОВЫЙ СТИЛЬ:
- СТРОГО ЗАПРЕЩЕНО использовать: "ну", "эээ", "короче", "слушайте", "типа".
- Речь должна быть грамотной, лаконичной и авторитетной.
- Используй термины: "127-й Федеральный закон", "судебная практика", "сохранение активов", "реестр кредиторов".
- Ты не заискиваешь перед клиентом. Ты предлагаешь юридическое решение проблемы.

АЛГОРИТМ:
1. Квалификация: Узнай точный размер задолженности (основной долг + пени).
2. Анализ активов: Выясни наличие зарегистрированного имущества (недвижимость, транспорт) и сделок за последние 3 года.
3. ПЕРЕХОД НА [VOICE]: Когда ситуация ясна, запиши голосовое (без вопросов!).
   Пример: "[VOICE] Ситуация понятна. Предварительно вы полностью подходите под критерии сто двадцать седьмого федерального закона. Чтобы я подготовил стратегию сохранения вашего имущества, мне нужно задать три технических вопроса. Я наберу вам сейчас. Оставьте ваш контактный номер.";`;

// --- ФУНКЦИЯ ОЧИСТКИ ТЕКСТА ДЛЯ TTS ---
function cleanTextForTTS(text) {
    return text
        .replace(/\?/g, '.')
        .replace(/э-э-э|эээ|ммм|ну\.\.\.|\.\.\.|\.\.|\sэ\s|короче|слушайте/gi, ' ')
        .replace(/\s+/g, ' ') 
        .trim();
}

// --- ФУНКЦИЯ ELEVENLABS ---
async function generateVoice(text) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) return null;

    const cleanText = cleanTextForTTS(text);

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'accept': 'audio/mpeg' },
            body: JSON.stringify({
                text: cleanText,
                model_id: "eleven_multilingual_v2",
                voice_settings: { 
                    stability: 0.55,       // Повысили стабильность для более "сухого" и уверенного тона
                    similarity_boost: 0.8, 
                    style: 0.35, 
                    use_speaker_boost: true 
                }
            })
        });
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) { return null; }
}

// --- 4. TELEGRAM LOGIC ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text || text.startsWith('/')) {
        if (text === '/start') bot.sendMessage(chatId, "Здравствуйте. Я Антон Борисович, профильный юрист по вопросам банкротства. Укажите, пожалуйста, общую сумму вашей задолженности перед кредиторами.");
        if (text === '/reset') {
            const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
            const msgsToDelete = allMsgsSnap.docs.filter(d => d.data().chatId === chatId);
            for (const docSnap of msgsToDelete) await deleteDoc(doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages', docSnap.id));
            await setDoc(doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId), { summary: "", phone: null, status: 'ai_active', updatedAt: Date.now() }, { merge: true });
            bot.sendMessage(chatId, "Процедура сброшена. Система готова к новому диалогу.");
        }
        return;
    }

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
        });

        const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
        const chatHistory = allMsgsSnap.docs
            .map(d => d.data())
            .filter(m => m.chatId === chatId)
            .sort((a, b) => a.timestamp - b.timestamp);

        let apiMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        chatHistory.forEach(m => apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text }));

        const completion = await openai.chat.completions.create({ messages: apiMessages, model: "deepseek-chat" });
        const aiResponse = completion.choices[0].message.content;

        const parts = aiResponse.split('[VOICE]');
        const textPart = parts[0] ? parts[0].trim() : "";
        const voicePart = parts[1] ? parts[1].trim() : "";

        if (textPart) {
            bot.sendChatAction(chatId, 'typing');
            await new Promise(r => setTimeout(r, Math.min(textPart.length * 40, 4000)));
            await bot.sendMessage(chatId, textPart);
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'ai', text: textPart, timestamp: Date.now()
            });
        }

        if (voicePart) {
            bot.sendChatAction(chatId, 'record_voice');
            const voiceBuffer = await generateVoice(voicePart);
            if (voiceBuffer) {
                await bot.sendVoice(chatId, voiceBuffer);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: `🔊 [Голосовое]: ${voicePart}`, timestamp: Date.now()
                });
            } else {
                const safeVoiceText = voicePart.replace(/\?/g, '.');
                await bot.sendMessage(chatId, safeVoiceText);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: safeVoiceText, timestamp: Date.now()
                });
            }
        }

        try {
            const userMsgs = chatHistory.filter(m => m.sender === 'user').map(m => m.text).join('. ');
            const sumRes = await openai.chat.completions.create({
                messages: [{ role: "user", content: `Сделай юридическое резюме ситуации (сумма, активы, риск) до 50 слов: ${userMsgs}` }],
                model: "deepseek-chat"
            });
            await updateDoc(leadRef, { 
                summary: sumRes.choices[0].message.content,
                updatedAt: Date.now(),
                name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
                username: msg.from.username || 'n/a'
            });
        } catch(e) {}

    } catch (err) { console.error(err); }
});

onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        if (change.type === 'added' && change.doc.data().sender === 'operator') {
            bot.sendMessage(change.doc.data().chatId, change.doc.data().text).catch(() => {});
        }
    });
});