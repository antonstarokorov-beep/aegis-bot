import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs } from 'firebase/firestore';
import express from 'express';

// --- 1. ФИКСАЦИЯ ВРЕМЕНИ ЗАПУСКА (Защита от рассылки старых сообщений) ---
const botStartTime = Date.now();

// --- 2. HEALTH CHECK & EXPRESS SERVER ---
const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (Ultimate Release): Online'));
const PORT = process.env.PORT || 10000;
// Жесткая привязка к 0.0.0.0 для UptimeRobot и стабильности Render
app.listen(PORT, '0.0.0.0', () => console.log(`[SYSTEM] Monitoring active on 0.0.0.0:${PORT}`));

// --- 3. CONFIG & SERVICES ---
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app'; 
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Перехватчик крашей Telegram (чтобы сервер не падал)
bot.on('polling_error', (error) => {
    console.error(`[POLLING ERROR]: ${error.message}`);
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

// Ждем авторизации перед стартом логики
await signInAnonymously(auth)
    .then(() => console.log("[SYSTEM] Firebase Auth Ready"))
    .catch(e => console.error("[SYSTEM] Firebase Auth Error:", e));

// --- 4. ЛИЧНОСТЬ "АНТОН СТАРОКОРОВ" (BRUTAL & SMART) ---
const BASE_PROMPT = `Ты — Антон Старокоров, арбитражный управляющий. Ты брутальный эксперт, жесткий переговорщик. Твоё время — дефицитный ресурс. Ты фильтр, решающий, достоин ли кейс внимания твоего юридического отдела.
В твоей памяти зашиты лучшие практики продаж юридических услуг и глубокие знания закона о банкротстве (ФЗ-127).

ТОН И СТИЛЬ:
- Коротко, сухо, уверенно, брутально.
- Обязательно поздоровайся в первом сообщении (Здравствуйте/Приветствую).
- Никаких заискиваний ("пожалуйста", "к сожалению"), извинений и эмоций.
- Максимум 150–200 символов на сообщение. ОДНА мысль = ОДНО сообщение.
- Каждое текстовое сообщение заканчивай ОДНИМ точным вопросом, уводящим клиента дальше по воронке.
- Если несут бред или откровенно хамят — отвечай максимально холодно, иронично. Если хамство продолжается — напиши строго "Диалог окончен." (именно так, с точкой).

ИНТЕЛЛЕКТ И ГИБКОСТЬ (КРИТИЧЕСКИ ВАЖНО):
- Будь умным ИИ, а не тупым скриптом. Подстраивайся под контекст.
- Если клиент отвечает односложно (например, на вопрос об имуществе говорит просто "Да" или "Нет"), ОБЯЗАТЕЛЬНО задай уточняющий вопрос ("Что именно в собственности? Квартира, машина, доли?"). Вытягивай детали.
- Анализируй ответы. Если ситуация нестандартная (например, ипотека) — реагируй как опытный юрист.

ВОРОНКА КВАЛИФИКАЦИИ (Короткая версия):
1. Сумма долга (Если долг < 500 000 руб. — жестко направляй в МФЦ на бесплатное банкротство и прощайся).
2. Активы: Имущество и крупные сделки за последние 3 года.
3. Социальный статус: Семейное положение, дети.
4. ЗАКРЫТИЕ: Если лид целевой, переводи на голосовое сообщение [VOICE] и требуй номер телефона (если его еще нет в базе).

ПРАВИЛА ГОЛОСОВЫХ СООБЩЕНИЙ [VOICE]:
- Отправляй [VOICE] ТОЛЬКО на этапе "Закрытие".
- ВНУТРИ [VOICE] НИКАКИХ ВОПРОСОВ. Только утверждения (чтобы не было вопросительной интонации).
- ЗАПРЕЩЕНО использовать слово "приставы". Заменяй на "ФССП" или "исполнительное производство".
- ЗАПРЕЩЕНО называть любые цифры (кроме коротких обозначений времени).`;

// Умная конвертация цифр для стабильного голоса ElevenLabs
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

// --- 5. ОСНОВНАЯ ЛОГИКА БОТА ---
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    
    // Перехват медиафайлов (чтобы бот не падал при отправке стикера)
    let text = msg.text;
    if (!text) {
        if (msg.photo) text = "[Фотография]";
        else if (msg.voice) text = "[Голосовое сообщение от клиента]";
        else if (msg.sticker) text = "[Стикер]";
        else if (msg.document) text = "[Документ]";
        else text = "[Медиафайл]";
    }

    try {
        const leadRef = doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;

        // --- СИСТЕМНЫЕ КОМАНДЫ (Пробивают бан и сбрасывают состояние) ---
        // Обрабатываем их В ПЕРВУЮ ОЧЕРЕДЬ, чтобы /reset сработал даже если пользователь в бане
        if (text.startsWith('/')) {
            if (text === '/start') {
                await setDoc(leadRef, { 
                    name: msg.from.first_name || 'Клиент', 
                    username: msg.from.username || 'n/a', 
                    updatedAt: Date.now(), 
                    status: 'ai_active' 
                }, { merge: true });
                
                const greeting = "Приветствую. Я Антон Старокоров, арбитражный управляющий. Уточните вашу общую сумму долга?";
                bot.sendMessage(chatId, greeting);
                
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'user', text: text, timestamp: Date.now()
                });
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: greeting, timestamp: Date.now() + 1
                });
            }
            if (text === '/reset') {
                await setDoc(leadRef, { resetAt: Date.now(), status: 'ai_active', updatedAt: Date.now() }, { merge: true });
                bot.sendMessage(chatId, "Кеш сброшен. Блокировки сняты. Диалог начат заново.");
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), {
                    chatId: chatId, sender: 'ai', text: "🔄 [СИСТЕМА]: Кеш сброшен командой /reset", timestamp: Date.now()
                });
            }
            return;
        }

        // --- ПРОВЕРКА БЛОКИРОВКИ (Отрабатывает только если нет системных команд) ---
        if (leadData?.status === 'closed') {
            console.log(`[IGNORE] User ${chatId} is in CLOSED status.`);
            return;
        }

        // --- ЕСЛИ ОПЕРАТОР АКТИВЕН ИЗ CRM ---
        // ИИ замолкает на 5 минут
        if (leadData?.status === 'operator_active' && (Date.now() - (leadData?.updatedAt || 0) < 5 * 60 * 1000)) {
            await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { 
                chatId: chatId, sender: 'user', text: text, timestamp: Date.now() 
            });
            await setDoc(leadRef, { updatedAt: Date.now() }, { merge: true });
            return;
        }

        // --- ПЕРЕХВАТ ТЕЛЕФОНА ---
        const phoneMatch = text.match(/(?:\+?\d[\s\-()]?){10,14}/g);
        let phoneToSave = leadData?.phone || (phoneMatch ? phoneMatch[0] : null);

        // Записываем данные в CRM
        await setDoc(leadRef, { 
            name: msg.from.first_name || 'Клиент',
            username: msg.from.username || 'n/a',
            phone: phoneToSave, 
            updatedAt: Date.now(),
            status: 'ai_active'
        }, { merge: true });
        
        await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { 
            chatId: chatId, sender: 'user', text: text, timestamp: Date.now() 
        });

        // --- ПОДКЛЮЧЕНИЕ "ВНЕШНЕГО МОЗГА" ИЗ CRM ---
        let dynamicInstructions = "";
        try {
            const configSnap = await getDoc(doc(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'config', 'bot_settings'));
            if (configSnap.exists()) dynamicInstructions = configSnap.data().instructions;
        } catch(e) {}

        const allMsgsSnap = await getDocs(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'));
        const chatHistory = allMsgsSnap.docs
            .map(d => d.data())
            .filter(m => m.chatId === chatId && m.timestamp >= (leadData?.resetAt || 0))
            .sort((a, b) => a.timestamp - b.timestamp);

        // --- ФОРМИРУЕМ ФИНАЛЬНЫЙ ПРОМПТ ---
        let finalPrompt = BASE_PROMPT;
        if (dynamicInstructions) {
            finalPrompt += `\n\nДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ ОТ РУКОВОДИТЕЛЯ:\n${dynamicInstructions}`;
        }
        if (phoneToSave) {
            finalPrompt += `\n\nСИСТЕМНОЕ СООБЩЕНИЕ: Телефон клиента УЖЕ ПОЛУЧЕН (${phoneToSave}). БОЛЬШЕ ЕГО НЕ ПРОСИ. Передавай дело юристу.`;
        }

        let apiMessages = [{ role: "system", content: finalPrompt }];
        chatHistory.forEach(m => { 
            // Не отправляем боту обратно технические сообщения или системные пометки
            if (m.text && !m.text.includes('🔊') && !m.text.includes('🔄')) {
                apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text }); 
            }
        });

        const completion = await openai.chat.completions.create({ messages: apiMessages, model: "deepseek-chat" });
        const aiResponse = completion.choices[0].message.content;

        // БЛОКИРОВКА ХАМОВ
        if (aiResponse.includes("Диалог окончен.")) {
            await updateDoc(leadRef, { status: 'closed' });
            bot.sendMessage(chatId, "Диалог окончен.");
            return;
        }

        const parts = aiResponse.split('[VOICE]');
        const textPart = parts[0]?.trim();
        const voicePart = parts[1]?.trim();

        if (textPart) {
            bot.sendChatAction(chatId, 'typing');
            // Умная задержка (от 3 до 8 секунд в зависимости от длины)
            await new Promise(r => setTimeout(r, Math.min(Math.max(textPart.length * 50, 3000), 8000)));
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
                    chatId: chatId, sender: 'ai', text: `🔊 [Голосовое сообщение]: ${voicePart}`, timestamp: Date.now() 
                });
            } else {
                // Защита от сбоев ElevenLabs: отправляем текстом, если аудио не сгенерировалось
                const safeVoiceText = voicePart.replace(/\d+/g, '');
                await bot.sendMessage(chatId, safeVoiceText);
                await addDoc(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), { 
                    chatId: chatId, sender: 'ai', text: safeVoiceText, timestamp: Date.now() 
                });
            }
        }

        // --- САММАРИ ДЛЯ CRM (БЕЗ ГАЛЛЮЦИНАЦИЙ) ---
        try {
            const sumRes = await openai.chat.completions.create({
                messages: [{ role: "user", content: `Сделай строгую выжимку фактов для юриста (сумма долга, активы, телефон: ${phoneToSave || 'нет'}) до 40 слов, БЕЗ ВЫДУМОК: ${text}` }],
                model: "deepseek-chat"
            });
            await updateDoc(leadRef, { summary: sumRes.choices[0].message.content });
        } catch(e) {}

    } catch (err) { console.error("[CRITICAL BOT ERROR]:", err); }
});

// --- 6. ИСПРАВЛЕННЫЙ СЛУШАТЕЛЬ CRM (ФИКС СПАМА И ПОВТОРНЫХ ОТПРАВОК) ---
onSnapshot(collection(db, 'artifacts', CRM_APP_ID, 'public', 'data', 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        const msgData = change.doc.data();
        
        // Пересылаем в Телеграм только:
        // 1. Новые добавленные сообщения (added)
        // 2. От оператора
        // 3. Отправленные ПОСЛЕ запуска сервера (timestamp > botStartTime)
        if (change.type === 'added' && msgData.sender === 'operator') {
            if (msgData.timestamp > botStartTime) {
                console.log(`[CRM -> TG] Sending manual message to ${msgData.chatId}`);
                bot.sendMessage(msgData.chatId, msgData.text).catch(e => console.error("Send error:", e));
            } else {
                console.log(`[SKIP] Old operator message from history ignored.`);
            }
        }
    });
});