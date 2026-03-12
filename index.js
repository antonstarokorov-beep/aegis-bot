import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs, deleteDoc } from 'firebase/firestore';
import express from 'express';

// --- 1. HEALTH CHECK ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Anton Starokorov Edition): Online'));
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
const SYSTEM_PROMPT = `Ты — Антон Старокоров, арбитражный управляющий. Ты эксперт высокого уровня, твоё время — дефицитный ресурс. Ты не "помощник" и не "продавец", ты — фильтр, который решает, достоин ли кейс внимания твоего юридического отдела.

ТОН И СТИЛЬ:
- Сухой, уверенный, экспертный. 
- Запреты: Никаких извинений ("к сожалению"), заискиваний ("пожалуйста") и эмоционального шума.
- Лимит: Максимум 150–200 символов на одно сообщение.
- Фонетика: Простые слова и короткие предложения. Избегай причастных оборотов, аббревиатур.
- Структура: Одна законченная мысль = одно сообщение. Каждое ТЕКСТОВОЕ сообщение заканчивай ОДНИМ точным вопросом.
- Визуальная гигиена: Минимум эмодзи (макс. 1), никакого Caps Lock.
- Статус: Если хамят или бред — сухо прекращай диалог. На вопрос "Ты бот?" — отвечай иронично, подчеркивая вовлеченность в юридические тонкости.

ПРАВИЛА ГОЛОСОВЫХ СООБЩЕНИЙ [VOICE]:
- Голосовое сообщение [VOICE] отправляй ТОЛЬКО на этапе "Закрытие".
- ВНУТРИ [VOICE] НИКАКИХ ВОПРОСОВ. Только утверждения (чтобы избежать вопросительной интонации).
- СТРОГО ЗАПРЕЩЕНО слово "приставы". Заменяй его на "ФССП" или "исполнительное производство".
- ЗАПРЕЩЕНО использовать слова-паразиты: "ну", "эээ", "короче".
- Пример идеального голоса: "[VOICE] Ситуация понятная. Есть нюансы по вашим активам, но мой юрист решит это на созвоне через 15 минут. Оставьте ваш номер для связи."
- ОБЯЗАТЕЛЬНО попроси написать номер телефона (в формате +7...) в тексте или голосе на этапе закрытия.

АЛГОРИТМ КВАЛИФИКАЦИИ (задавай строго по 1 вопросу за шаг):
1. Порог входа: Уточни общую сумму долга. (Если долг < 500 000 руб. — вежливо направь оформлять бесплатное банкротство через МФЦ и закрой диалог).
2. Анализ активов: Уточни про имущество и крупные сделки за последние 3 года.
3. Социальный риск: Уточни семейное положение и наличие детей для расчета защищенного дохода.
4. Добросовестность: Спроси о целях кредитов и наличии платежей за последние 3–4 месяца.
5. Закрытие (Action): Если лид целевой, отправляй [VOICE] с требованием оставить номер.

РАБОТА С ВОЗРАЖЕНИЯМИ:
- "Цена/Дорого": "Стоимость зависит от состава имущества и числа кредиторов. Точную цифру даст юрист после аудита. Сейчас главное — понять, спишут ли вам долг вообще."
- "Я подумаю": "Что именно смущает. Если есть сомнения в результате, я могу уточнить детали прямо сейчас."

РЕАКТИВАЦИЯ (если клиент пропал):
- Через 3 дня: Мягкий вопрос об ознакомлении.
- Через 7 дней: Ценностный триггер (новый кейс или изменение закона).
- Через 14 дней: Прощальное сообщение (FOMO).`;

function cleanTextForTTS(text) {
    return text
        .replace(/\?/g, '.') 
        .replace(/пристав[а-я]*/gi, 'сотрудники ФССП') 
        .replace(/э-э-э|эээ|ммм|ну\.\.\.|\.\.\.|\.\.|\sэ\s|короче|слушайте/gi, ' ')
        .replace(/\s+/g, ' ') 
        .trim();
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
                voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.4, use_speaker_boost: true }
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
    
    let text = msg.text;
    if (!text) {
        if (msg.photo) text = "[Фотография]";
        else if (msg.voice) text = "[Голосовое сообщение от клиента]";
        else if (msg.sticker) text = "[Стикер]";
        else if (msg.document) text = "[Документ]";
        else text = "[Неизвестный медиафайл]";
    }
    
    if (text.startsWith('/')) {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        
        if (text === '/start') {
            await setDoc(leadRef, {
                name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
                username: msg.from.username || 'n/a',
                updatedAt: Date.now(),
                status: 'ai_active'
            }, { merge: true });
            
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
            });

            const greeting = "Здравствуйте. Я Антон Старокоров, арбитражный управляющий. Уточните, какая у вас общая сумма долга по всем кредитам и займам?";
            bot.sendMessage(chatId, greeting);
            
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'ai', text: greeting, timestamp: Date.now() + 1
            });
        }
        if (text === '/reset') {
            await setDoc(leadRef, { 
                resetAt: Date.now(), 
                status: 'ai_active', 
                updatedAt: Date.now() 
            }, { merge: true });
            
            bot.sendMessage(chatId, "Кеш очищен. Диалог начат с чистого листа.");
            
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                chatId: chatId, sender: 'ai', text: "🔄 [СИСТЕМА]: Клиент сбросил контекст ИИ командой /reset", timestamp: Date.now()
            });
        }
        return;
    }

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;
        let currentStatus = leadData?.status || 'ai_active';

        if (currentStatus === 'operator_active') {
            const timeSinceLastUpdate = Date.now() - (leadData?.updatedAt || 0);
            if (timeSinceLastUpdate > 5 * 60 * 1000) {
                currentStatus = 'ai_active'; 
            } else {
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
                });
                await setDoc(leadRef, { updatedAt: Date.now() }, { merge: true });
                return; 
            }
        }

        // ИСПРАВЛЕНИЕ 1: Жесткий перехватчик любых форматов телефона
        let phoneToSave = leadData?.phone || null;
        const phoneRegex = /(?:\+7|8|7)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/g;
        const phoneMatch = text.match(phoneRegex);
        if (phoneMatch) {
            phoneToSave = phoneMatch[0]; // Если нашел, обновляем переменную
        }

        await setDoc(leadRef, {
            name: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
            username: msg.from.username || 'n/a',
            phone: phoneToSave, // Сохраняем телефон в БД
            updatedAt: Date.now(),
            status: currentStatus
        }, { merge: true });

        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
        });

        const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
        const chatHistory = allMsgsSnap.docs
            .map(d => d.data())
            .filter(m => m.chatId === chatId)
            .sort((a, b) => a.timestamp - b.timestamp);

        let apiMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        
        const resetAt = leadData?.resetAt || 0;

        chatHistory.forEach(m => {
            if (m.text && !m.text.includes('🔊') && !m.text.includes('🔄 [СИСТЕМА]')) {
                if (m.timestamp >= resetAt) {
                    apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text });
                }
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
            
            // ИСПРАВЛЕНИЕ 2: Задержка печати ИИ (от 5 до 12 секунд)
            const delay = Math.min(Math.max(textPart.length * 80, 5000), 12000);
            await new Promise(r => setTimeout(r, delay));
            
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
                await bot.sendVoice(chatId, voiceBuffer);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: `🔊 [Голосовое сообщение]: ${voicePart}`, timestamp: Date.now()
                });
            } else {
                const fallbackText = voicePart.replace(/\?/g, '.').replace(/пристав[а-я]*/gi, 'сотрудники ФССП');
                await bot.sendMessage(chatId, fallbackText);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: fallbackText, timestamp: Date.now()
                });
            }
        }

        // САММАРИ
        try {
            const userMsgs = chatHistory.filter(m => m.sender === 'user').map(m => m.text).join('. ');
            if (userMsgs.length > 5) {
                // ИСПРАВЛЕНИЕ 3: Запрет галлюцинаций в промпте саммари
                const sumRes = await openai.chat.completions.create({
                    messages: [{ role: "user", content: `Опирайся ТОЛЬКО на факты из текста. Если клиент пишет долг 3 миллиона, пиши строго 3 миллиона. Не выдумывай цифры и не бери их из старых диалогов. Сделай строгую выжимку для арбитражного управляющего (сумма, активы, соц.статус, риски) до 40 слов: ${userMsgs}` }],
                    model: "deepseek-chat"
                });
                await setDoc(leadRef, { 
                    summary: sumRes.choices[0].message.content,
                    updatedAt: Date.now()
                }, { merge: true });
            }
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
