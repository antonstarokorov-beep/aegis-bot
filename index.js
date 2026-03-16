import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs } from 'firebase/firestore';
import express from 'express';

// --- ЗАЩИТА: ПРОВЕРКА TENANT_ID ---
// ВАЖНО: Добавь свой ID из CRM (вкладка Безопасность) в файл .env бота
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
    console.error("[ФАТАЛЬНАЯ ОШИБКА] Не указан TENANT_ID в файле .env!");
    console.error("Пожалуйста, скопируй Tenant ID из вкладки 'Безопасность' в CRM.");
    process.exit(1); 
}

const botStartTime = Date.now();

const app = express();
app.get('/', (req, res) => res.send('Aegis Bot (SaaS Node): Online'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`[SYSTEM] Monitoring active on 0.0.0.0:${PORT}`));

const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app'; 
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => console.error(`[POLLING ERROR]: ${error.message}`));

const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1', 
    apiKey: process.env.DEEPSEEK_API_KEY,
    timeout: 60000, 
    maxRetries: 3   
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

await signInAnonymously(auth)
    .then(() => console.log(`[SYSTEM] Firebase Auth Ready. Connected to Tenant: ${TENANT_ID}`))
    .catch(e => console.error("[SYSTEM] Firebase Auth Error:", e));

// Базовый (дефолтный) алгоритм, если клиент еще не настроил свой в CRM
const DEFAULT_PROMPT = `Ты — AI-Агент. Твоя цель — квалифицировать лид и взять номер телефона. Задавай вопросы по одному.`;

function numberToWords(num) {
    const map = { '15': 'пятнадцати', '10': 'десяти', '20': 'двадцати', '30': 'тридцати', '5': 'пяти' };
    return map[num] || num;
}

function cleanTextForTTS(text) {
    return text.replace(/\?/g, '.').replace(/пристав[а-я]*/gi, 'сотрудники ФССП').replace(/\d{5,}/g, ' ').replace(/\b(15|10|20|30|5)\b/g, (m) => numberToWords(m)).replace(/\s+/g, ' ').trim();
}

async function generateVoice(text) {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) return null;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanTextForTTS(text), model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.8 } }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (e) { return null; }
}

// --- БАЗОВЫЙ ПУТЬ ДЛЯ ДАННЫХ ЭТОГО КЛИЕНТА (TENANT) ---
const tenantPath = `artifacts/${CRM_APP_ID}/users/${TENANT_ID}`;

bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    let text = msg.text;
    if (!text) {
        if (msg.photo) text = "[Фотография]";
        else if (msg.voice) text = "[Голосовое сообщение от клиента]";
        else if (msg.sticker) text = "[Стикер]";
        else if (msg.document) text = "[Документ]";
        else text = "[Медиафайл]";
    }

    try {
        const leadRef = doc(db, tenantPath, 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;

        // СИСТЕМНЫЕ КОМАНДЫ И UTM
        if (text.startsWith('/')) {
            if (text.startsWith('/start')) {
                let utmData = null;
                const parts = text.split(' ');
                if (parts.length > 1) {
                    try {
                        const searchParams = new URLSearchParams(parts[1]);
                        utmData = {
                            source: searchParams.get('utm_source') || null,
                            medium: searchParams.get('utm_medium') || null,
                            campaign: searchParams.get('utm_campaign') || null,
                            raw: parts[1]
                        };
                    } catch (e) {}
                }
                
                await setDoc(leadRef, { 
                    name: msg.from.first_name || 'Клиент', 
                    username: msg.from.username || 'n/a', 
                    updatedAt: Date.now(), 
                    status: 'ai_active',
                    utm_data: utmData,
                    firstSeenAt: Date.now()
                }, { merge: true });
                
                const greeting = "Здравствуйте. Каким вопросом я могу вам помочь?";
                bot.sendMessage(chatId, greeting);
                
                await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'user', text, timestamp: Date.now() });
                await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: greeting, timestamp: Date.now() + 1 });
            }
            if (text === '/reset') {
                await setDoc(leadRef, { resetAt: Date.now(), status: 'ai_active', updatedAt: Date.now() }, { merge: true });
                bot.sendMessage(chatId, "Кеш сброшен. Диалог начат заново.");
                await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: "🔄 [СИСТЕМА]: Кеш сброшен", timestamp: Date.now() });
            }
            return;
        }

        if (leadData?.status === 'closed') return;

        if (leadData?.status === 'operator_active' && (Date.now() - (leadData?.updatedAt || 0) < 5 * 60 * 1000)) {
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'user', text, timestamp: Date.now() });
            await setDoc(leadRef, { updatedAt: Date.now() }, { merge: true });
            return;
        }

        const phoneMatch = text.match(/(?:\+?\d[\s\-()]?){10,14}/g);
        let phoneToSave = leadData?.phone || (phoneMatch ? phoneMatch[0] : null);

        await setDoc(leadRef, { 
            name: msg.from.first_name || 'Клиент', username: msg.from.username || 'n/a', phone: phoneToSave, updatedAt: Date.now(), status: 'ai_active'
        }, { merge: true });
        
        await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'user', text, timestamp: Date.now() });

        // ЧИТАЕМ МОЗГ (ПРОМПТ) ИЗ CRM ДЛЯ ДАННОГО КЛИЕНТА
        let dynamicInstructions = DEFAULT_PROMPT;
        try {
            const configSnap = await getDoc(doc(db, tenantPath, 'config', 'bot_settings'));
            if (configSnap.exists() && configSnap.data().instructions) {
                dynamicInstructions = configSnap.data().instructions;
            }
        } catch(e) {}

        const allMsgsSnap = await getDocs(collection(db, tenantPath, 'messages'));
        const chatHistory = allMsgsSnap.docs.map(d => d.data()).filter(m => m.chatId === chatId && m.timestamp >= (leadData?.resetAt || 0)).sort((a, b) => a.timestamp - b.timestamp);

        let finalPrompt = dynamicInstructions;
        if (phoneToSave) finalPrompt += `\n\nСИСТЕМНОЕ СООБЩЕНИЕ: Телефон клиента УЖЕ ПОЛУЧЕН (${phoneToSave}). БОЛЬШЕ ЕГО НЕ ПРОСИ. Ожидайте связи.`;

        let apiMessages = [{ role: "system", content: finalPrompt }];
        chatHistory.forEach(m => { 
            if (m.text && !m.text.includes('🔊') && !m.text.includes('🔄') && !m.text.includes('⚠️')) {
                apiMessages.push({ role: m.sender === 'user' ? "user" : "assistant", content: m.text }); 
            }
        });

        const completion = await openai.chat.completions.create({ messages: apiMessages, model: "deepseek-chat" });
        const aiResponse = completion.choices[0].message.content;

        if (aiResponse.includes("Диалог окончен.")) {
            await updateDoc(leadRef, { status: 'closed' });
            bot.sendMessage(chatId, "Диалог окончен.");
            return;
        }

        const parts = aiResponse.split(/\[VOICE\]/i);
        let textPart = parts[0]?.trim() || "";
        let voicePart = parts.length > 1 ? parts[1]?.trim() : "";

        if (!textPart && !voicePart) textPart = "Пожалуйста, оставьте ваш номер телефона, специалист свяжется с вами.";

        if (textPart) {
            bot.sendChatAction(chatId, 'typing');
            await new Promise(r => setTimeout(r, Math.min(Math.max(textPart.length * 50, 3000), 8000)));
            await bot.sendMessage(chatId, textPart);
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: textPart, timestamp: Date.now() });
        }

        if (voicePart) {
            bot.sendChatAction(chatId, 'record_voice');
            const voiceBuffer = await generateVoice(voicePart);
            if (voiceBuffer) {
                await bot.sendVoice(chatId, voiceBuffer);
                await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: `🔊 [Голосовое сообщение]: ${voicePart}`, timestamp: Date.now() });
            } else {
                const safeVoiceText = voicePart.replace(/\d+/g, '');
                await bot.sendMessage(chatId, safeVoiceText);
                await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: safeVoiceText, timestamp: Date.now() });
            }
        }

        try {
            const sumRes = await openai.chat.completions.create({
                messages: [{ role: "user", content: `Сделай строгую выжимку фактов для менеджера (потребности, телефон: ${phoneToSave || 'нет'}) до 40 слов, БЕЗ ВЫДУМОК: ${text}` }],
                model: "deepseek-chat"
            });
            await updateDoc(leadRef, { summary: sumRes.choices[0].message.content });
        } catch(e) {}

    } catch (err) { 
        console.error("[CRITICAL BOT ERROR]:", err); 
        try {
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: `⚠️ [ОШИБКА ИИ]: Сбой. Перехватите диалог.`, timestamp: Date.now() });
            await bot.sendMessage(chatId, "Извините, возникла техническая заминка. Сейчас передам диалог специалисту.");
        } catch (e) {}
    }
});

onSnapshot(collection(db, tenantPath, 'messages'), (snap) => {
    snap.docChanges().forEach(change => {
        const msgData = change.doc.data();
        if (change.type === 'added' && msgData.sender === 'operator' && msgData.timestamp > botStartTime) {
            bot.sendMessage(msgData.chatId, msgData.text).catch(e => console.error("Send error:", e));
        }
    });
});