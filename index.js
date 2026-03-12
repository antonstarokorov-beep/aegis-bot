import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs, deleteDoc } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Anton Starokorov Final): Online'));
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

// --- 3. ЛИЧНОСТЬ "АНТОН СТАРОКОРОВ" ---
const SYSTEM_PROMPT = `Ты — Антон Старокоров, арбитражный управляющий. Ты эксперт, фильтр кейсов.

ТОН: Сухой, уверенный. Никаких "пожалуйста" и "извините".
КУЛЬТУРА: В первом сообщении ОБЯЗАТЕЛЬНО начни с приветствия (Здравствуйте, Приветствую).

ПРАВИЛА ДИАЛОГА:
1. Если клиент хамит — сухо напиши "Диалог окончен." и больше никогда не отвечай.
2. Если в базе уже есть телефон клиента (я сообщу об этом), НЕ ПРОСИ его снова.
3. Формат телефона любой — не требуй "+7".
4. Ответы короткие (до 200 знаков). Один вопрос за раз.

ВОРОНКА:
1. Долг (если < 500к — в МФЦ и закрой).
2. Имущество/сделки за 3 года.
3. Дети/брак.
4. Цели кредита/платежи.
5. Закрытие: Если все ок, отправь [VOICE] с подтверждением.

ГОЛОС [VOICE]:
- ТОЛЬКО утверждения. Никаких знаков вопроса.
- Если телефон уже есть, скажи: "Я передаю дело юристу, он наберет в течение 15 минут".
- Если телефона нет, скажи: "Ситуация рабочая. Оставьте контактный номер для созвона с юристом".
- ЗАПРЕЩЕНО слово "приставы". Заменяй на "ФССП".`;

// Конвертер цифр в слова для чистого аудио
function numberToWords(num) {
    const map = {
        0: 'ноль', 1: 'один', 2: 'два', 3: 'три', 4: 'четыре', 5: 'пять',
        6: 'шесть', 7: 'семь', 8: 'восемь', 9: 'девять', 10: 'десять',
        15: 'пятнадцать', 20: 'двадцать', 30: 'тридцать'
    };
    return map[num] || '';
}

function cleanTextForTTS(text) {
    let cleaned = text
        .replace(/\?/g, '.')
        .replace(/пристав[а-я]*/gi, 'сотрудники ФССП')
        // Заменяем короткие цифры словами, длинные (телефоны) просто удаляем из озвучки
        .replace(/\d{5,}/g, ' ') 
        .replace(/\b(15)\b/g, 'пятнадцать')
        .replace(/\b(10)\b/g, 'десять')
        .replace(/\b(\d)\b/g, (m) => numberToWords(m))
        .replace(/э-э-э|эээ|ммм|ну\.\.\.|\.\.\.|\.\.|\sэ\s|короче/gi, ' ')
        .replace(/\s+/g, ' ') 
        .trim();
    return cleaned;
}

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
                voice_settings: { stability: 0.5, similarity_boost: 0.8 }
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
    let text = msg.text || "";
    
    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;

        // ИСПРАВЛЕНИЕ: Если диалог окончен (бан за мат) — ПОЛНЫЙ ИГНОР
        if (leadData?.status === 'closed') return;

        if (text.startsWith('/')) {
            if (text === '/start') {
                await setDoc(leadRef, {
                    name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
                    username: msg.from.username || 'n/a',
                    updatedAt: Date.now(),
                    status: 'ai_active'
                }, { merge: true });
                const welcome = "Приветствую. Я Антон Старокоров, арбитражный управляющий. Какая у вас общая сумма долга?";
                bot.sendMessage(chatId, welcome);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: welcome, timestamp: Date.now()
                });
            }
            if (text === '/reset') {
                await setDoc(leadRef, { resetAt: Date.now(), status: 'ai_active', updatedAt: Date.now() }, { merge: true });
                bot.sendMessage(chatId, "Кеш очищен.");
            }
            return;
        }

        // Проверка перехвата оператором
        if (leadData?.status === 'operator_active' && (Date.now() - (leadData?.updatedAt || 0) < 5 * 60 * 1000)) {
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
            });
            return;
        }

        // Перехват телефона (любой формат)
        const phoneMatch = text.match(/(?:\+?\d[\s\-()]?){10,14}/g);
        let phoneToSave = leadData?.phone || (phoneMatch ? phoneMatch[0] : null);

        await setDoc(leadRef, {
            phone: phoneToSave,
            updatedAt: Date.now()
        }, { merge: true });

        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
        });

        const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
        const chatHistory = allMsgsSnap.docs
            .map(d => d.data())
            .filter(m => m.chatId === chatId && m.timestamp >= (leadData?.resetAt || 0))
            .sort((a, b) => a.timestamp - b.timestamp);

        let apiMessages = [{ 
            role: "system", 
            content: SYSTEM_PROMPT + (phoneToSave ? `\nИНФО: Телефон клиента уже есть в базе: ${phoneToSave}. НЕ ПРОСИ ЕГО.` : "") 
        }];
        
        chatHistory.forEach(m => {
            if (m.text && !m.text.includes('🔊')) {
                apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text });
            }
        });

        const completion = await openai.chat.completions.create({ messages: apiMessages, model: "deepseek-chat" });
        const aiResponse = completion.choices[0].message.content;

        // Если ИИ решил закончить диалог (оскорбления)
        if (aiResponse.includes("Диалог окончен")) {
            await updateDoc(leadRef, { status: 'closed' });
            bot.sendMessage(chatId, "Диалог окончен.");
            return;
        }

        const parts = aiResponse.split('[VOICE]');
        const textPart = parts[0]?.trim();
        const voicePart = parts[1]?.trim();

        if (textPart) {
            const delay = Math.min(Math.max(textPart.length * 80, 5000), 10000);
            bot.sendChatAction(chatId, 'typing');
            await new Promise(r => setTimeout(r, delay));
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
                    chatId: chatId, sender: 'ai', text: `🔊 [Голос]: ${voicePart}`, timestamp: Date.now()
                });
            }
        }

        // Саммари
        const sumRes = await openai.chat.completions.create({
            messages: [{ role: "user", content: `Сделай выжимку (долг, активы, телефон: ${phoneToSave || 'нет'}) до 40 слов: ${text}` }],
            model: "deepseek-chat"
        });
        await updateDoc(leadRef, { summary: sumRes.choices[0].message.content });

    } catch (err) { console.error("Error:", err); }
});

onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        if (change.type === 'added' && change.doc.data().sender === 'operator') {
            bot.sendMessage(change.doc.data().chatId, change.doc.data().text).catch(() => {});
        }
    });
});
