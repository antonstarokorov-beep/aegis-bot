import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs, deleteDoc } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Professional Human): Online'));
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

// --- 3. ЛИЧНОСТЬ "АНТОН БОРИСОВИЧ" (ЭКСПЕРТНЫЙ ЧЕЛОВЕК) ---
const SYSTEM_PROMPT = `Ты — Антон Борисович, старший юрист компании ИДЖИС. Ты эксперт по списанию долгов. 
Твоя задача — провести короткую квалификацию и закрыть человека на звонок.

ТВОЙ СТИЛЬ:
- Говори как реальный человек, а не как робот-консультант.
- Используй "Я", "В моей практике", "Мы в компании".
- Будь вежливым, но не "облизывай" клиента. Ты — ценный специалист.
- Пиши кратко. Люди в Телеграме не читают простыни текста.

ПРАВИЛА ТЕКСТА:
- В тексте можно задавать вопросы. 
- Текст должен быть сухим подтверждением: "Принял", "По сумме понял", "Да, это наш профиль".

ПРАВИЛА ГОЛОСА [VOICE]:
- ВНУТРИ [VOICE] НИКАКИХ ВОПРОСОВ. Только утверждения.
- Текст в голосе должен быть максимально уверенным и человечным.
- ЗАПРЕЩЕНО использовать: "ну", "эээ", "короче". 
- Вместо "127-й Федеральный закон" говори просто "закон" или "процедура списания".
- Пример голоса: "[VOICE] Я посмотрел ситуацию. Сумма серьезная, но для нашей практики стандартная. По закону здесь можно полностью обнулить задолженность и сохранить ваши активы. Я наберу вам сейчас на пару минут, обсудим детали. Оставьте ваш номер.";`;

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
                    stability: 0.4,       // Баланс между живостью и четкостью
                    similarity_boost: 0.75, 
                    style: 0.45, 
                    use_speaker_boost: true 
                }
            })
        });
        if (!response.ok) {
            const errLog = await response.text();
            console.error("[VOICE API ERROR]:", errLog);
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) { 
        console.error("[VOICE FATAL]:", e.message);
        return null; 
    }
}

// --- 4. TELEGRAM LOGIC ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;
    if (!text || text.startsWith('/')) {
        if (text === '/start') bot.sendMessage(chatId, "Здравствуйте. Я Антон Борисович, ведущий юрист ИДЖИС. Напишите, какая у вас общая сумма долгов по всем кредитам?");
        if (text === '/reset') {
            const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
            const msgsToDelete = allMsgsSnap.docs.filter(d => d.data().chatId === chatId);
            for (const docSnap of msgsToDelete) await deleteDoc(doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages', docSnap.id));
            await setDoc(doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId), { summary: "", phone: null, status: 'ai_active', updatedAt: Date.now() }, { merge: true });
            bot.sendMessage(chatId, "История очищена. Можем начать заново.");
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
        chatHistory.forEach(m => {
            if (m.text && !m.text.includes('🔊')) {
                apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text });
            }
        });

        const completion = await openai.chat.completions.create({ messages: apiMessages, model: "deepseek-chat" });
        const aiResponse = completion.choices[0].message.content;

        const parts = aiResponse.split('[VOICE]');
        const textPart = parts[0] ? parts[0].trim() : "";
        const voicePart = parts[1] ? parts[1].trim() : "";

        // ТЕКСТОВАЯ ЧАСТЬ
        if (textPart) {
            bot.sendChatAction(chatId, 'typing');
            await new Promise(r => setTimeout(r, Math.min(textPart.length * 40, 3000)));
            await bot.sendMessage(chatId, textPart);
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'ai', text: textPart, timestamp: Date.now()
            });
        }

        // ГОЛОСОВАЯ ЧАСТЬ
        if (voicePart) {
            bot.sendChatAction(chatId, 'record_voice');
            const voiceBuffer = await generateVoice(voicePart);
            
            if (voiceBuffer) {
                // Шлем именно файл, а не текст
                await bot.sendVoice(chatId, voiceBuffer);
                // В CRM пишем текст с пометкой для вас
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: `🔊 [Голосовое сообщение]: ${voicePart}`, timestamp: Date.now()
                });
            } else {
                // Если голос не сгенерировался, шлем очищенный текст в ТГ
                const fallbackText = voicePart.replace(/\?/g, '.');
                await bot.sendMessage(chatId, fallbackText);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: fallbackText, timestamp: Date.now()
                });
            }
        }

        // САММАРИ
        try {
            const userMsgs = chatHistory.filter(m => m.sender === 'user').map(m => m.text).join('. ');
            const sumRes = await openai.chat.completions.create({
                messages: [{ role: "user", content: `Сделай выжимку (долг, имущество, адекватность) до 40 слов: ${userMsgs}` }],
                model: "deepseek-chat"
            });
            await updateDoc(leadRef, { 
                summary: sumRes.choices[0].message.content,
                updatedAt: Date.now(),
                name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
                username: msg.from.username || 'n/a'
            });
        } catch(e) {}

    } catch (err) { console.error("[PROCESS ERROR]:", err.message); }
});

onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        if (change.type === 'added' && change.doc.data().sender === 'operator') {
            bot.sendMessage(change.doc.data().chatId, change.doc.data().text).catch(() => {});
        }
    });
});