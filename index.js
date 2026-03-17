import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import OpenAI from 'openai';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getFirestore, collection, addDoc, doc, setDoc, getDoc, updateDoc, onSnapshot, getDocs, deleteField } from 'firebase/firestore';
import express from 'express';

// --- ЗАЩИТА: ПРОВЕРКА TENANT_ID ---
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
    console.error("[ФАТАЛЬНАЯ ОШИБКА] Не указан TENANT_ID в файле .env!");
    process.exit(1); 
}

const botStartTime = Date.now();
const CRM_APP_ID = process.env.CRM_CUSTOM_APP_ID || 'aegis-leads-app'; 
const tenantPath = `artifacts/${CRM_APP_ID}/users/${TENANT_ID}`;

// --- ЭКСПРЕСС СЕРВЕР (Для приема вебхуков с сайтов в будущем) ---
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Aegis SaaS Omnichannel Engine: Online'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`[SYSTEM] Server listening on port ${PORT}`));

// --- ИНИЦИАЛИЗАЦИЯ СЕРВИСОВ ---
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
bot.on('polling_error', (error) => console.error(`[POLLING ERROR]: ${error.message}`));

const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com/v1', 
    apiKey: process.env.DEEPSEEK_API_KEY,
    timeout: 60000, 
    maxRetries: 3   
});

const fbApp = initializeApp({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
});
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

await signInAnonymously(auth)
    .then(() => console.log(`[SYSTEM] Firebase Auth Ready. Connected to Tenant: ${TENANT_ID}`))
    .catch(e => console.error("[SYSTEM] Firebase Auth Error:", e));

const DEFAULT_PROMPT = `Ты — AI-Агент. Твоя цель — квалифицировать лид и взять номер телефона. Задавай вопросы по одному.`;

function numberToWords(num) {
    const map = { '15': 'пятнадцати', '10': 'десяти', '20': 'двадцати', '30': 'тридцати', '5': 'пяти' };
    return map[num] || num;
}

function cleanTextForTTS(text) {
    return text.replace(/\?/g, '.').replace(/пристав[а-я]*/gi, 'сотрудники ФССП').replace(/\d{5,}/g, ' ').replace(/\b(15|10|20|30|5)\b/g, (m) => numberToWords(m)).replace(/\s+/g, ' ').trim();
}

async function generateVoice(text, elevenKey) {
    const apiKey = elevenKey || process.env.ELEVENLABS_API_KEY;
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

// ==========================================
// ИНТЕГРАЦИЯ С МЕССЕНДЖЕРОМ MAX (LONG POLLING)
// ==========================================

async function sendToMaxChat(chatId, text, maxToken) {
    if (!maxToken) return;
    try {
        const url = `https://myteam.mail.ru/api/bot/v1/messages/sendText?token=${maxToken}&chatId=${chatId}&text=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) console.error("[MAX SEND ERROR]:", await response.text());
    } catch (e) { console.error("[MAX NETWORK ERROR]:", e); }
}

let activeMaxToken = null;
let isMaxPolling = false;

// Цикл постоянного опроса серверов VK Teams (MAX)
async function pollMaxEvents() {
    let lastEventId = 0;
    console.log(`[SYSTEM] Запущен Long Polling для Мессенджера MAX`);
    
    while (isMaxPolling && activeMaxToken) {
        try {
            const url = `https://myteam.mail.ru/api/bot/v1/events/get?token=${activeMaxToken}&lastEventId=${lastEventId}&pollTime=30`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.ok && data.events && data.events.length > 0) {
                for (const event of data.events) {
                    lastEventId = event.eventId;
                    if (event.type === 'newMessage') {
                        const chatId = String(event.payload.chat.userId);
                        const text = event.payload.text;
                        const name = event.payload.from.firstName || 'Клиент MAX';
                        const username = event.payload.from.userId || 'n/a';
                        
                        await processAIConversation(chatId, text, 'max', { name, username });
                    }
                }
            }
        } catch (error) {
            console.error("[MAX POLLING ERROR]:", error.message);
            await new Promise(r => setTimeout(r, 5000)); // Пауза при ошибке сети
        }
    }
}

// Слушаем базу данных. Как только появляется токен MAX, запускаем его Polling
onSnapshot(doc(db, tenantPath, 'config', 'integrations'), (docSnap) => {
    if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.max_token && data.max_token !== activeMaxToken) {
            activeMaxToken = data.max_token;
            if (!isMaxPolling) {
                isMaxPolling = true;
                pollMaxEvents(); // Запускаем цикл
            }
        }
    }
});


// ==========================================
// ЦЕНТРАЛЬНОЕ ИИ-ЯДРО (TG + MAX)
// ==========================================
async function processAIConversation(chatId, text, source, userInfo) {
    try {
        const leadRef = doc(db, tenantPath, 'leads', chatId);
        const leadSnap = await getDoc(leadRef);
        let leadData = leadSnap.exists() ? leadSnap.data() : null;

        // ПАРСИНГ UTM МЕТОК
        let utmData = leadData?.utm_data || null;
        if (text.startsWith('/start')) {
            const parts = text.split(' ');
            if (parts.length > 1) {
                try {
                    const searchParams = new URLSearchParams(parts[1]);
                    utmData = {
                        source: searchParams.get('utm_source') || null,
                        medium: searchParams.get('utm_medium') || null,
                        campaign: searchParams.get('utm_campaign') || null,
                        term: searchParams.get('utm_term') || null,
                        content: searchParams.get('utm_content') || null,
                        raw: parts[1]
                    };
                } catch (e) {}
            }
            
            await setDoc(leadRef, { 
                name: userInfo.name, username: userInfo.username, source: source, utm_data: utmData,
                updatedAt: Date.now(), status: 'ai_active', firstSeenAt: Date.now()
            }, { merge: true });
            
            const greeting = "Здравствуйте. Каким вопросом я могу вам помочь?";
            
            let integrationsData = {};
            const intSnap = await getDoc(doc(db, tenantPath, 'config', 'integrations'));
            if (intSnap.exists()) integrationsData = intSnap.data();

            if (source === 'telegram') bot.sendMessage(chatId, greeting);
            else if (source === 'max') sendToMaxChat(chatId, greeting, integrationsData.max_token);
            
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'user', text, timestamp: Date.now() });
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: greeting, timestamp: Date.now() + 1 });
            return;
        }

        // НОВАЯ ЛОГИКА /reset (ПОЛНАЯ ОЧИСТКА ТЕЛЕФОНА И СТАТУСА CRM)
        if (text === '/reset') {
            await setDoc(leadRef, { 
                resetAt: Date.now(), 
                status: 'ai_active', 
                updatedAt: Date.now(),
                phone: null,            // Удаляем номер телефона
                crm_exported: false,    // Сбрасываем флаг экспорта
                summary: null           // Очищаем старое саммари
            }, { merge: true });
            
            let integrationsData = {};
            const intSnap = await getDoc(doc(db, tenantPath, 'config', 'integrations'));
            if (intSnap.exists()) integrationsData = intSnap.data();

            if (source === 'telegram') bot.sendMessage(chatId, "Кеш полностью сброшен. Номер удален. Начинаем заново.");
            else if (source === 'max') sendToMaxChat(chatId, "Кеш полностью сброшен. Номер удален. Начинаем заново.", integrationsData.max_token);
            
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: "🔄 [СИСТЕМА]: Кеш сброшен, лид обнулен", timestamp: Date.now() });
            return;
        }

        if (leadData?.status === 'closed') return;
        if (leadData?.status === 'operator_active' && (Date.now() - (leadData?.updatedAt || 0) < 5 * 60 * 1000)) {
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'user', text, timestamp: Date.now() });
            await setDoc(leadRef, { updatedAt: Date.now() }, { merge: true });
            return;
        }

        // ВЫТАСКИВАЕМ ТЕЛЕФОН
        const phoneMatch = text.match(/(?:\+?\d[\s\-()]?){10,14}/g);
        // Если телефон уже есть в базе, не перезаписываем его. Иначе берем новый.
        let phoneToSave = leadData?.phone || (phoneMatch ? phoneMatch[0] : null);

        await setDoc(leadRef, { 
            name: userInfo.name, username: userInfo.username, phone: phoneToSave, 
            source: source, updatedAt: Date.now(), status: 'ai_active'
        }, { merge: true });
        
        await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'user', text, timestamp: Date.now() });

        // ЧИТАЕМ НАСТРОЙКИ И КЛЮЧИ ИЗ БД
        let dynamicInstructions = DEFAULT_PROMPT;
        let integrationsData = {};
        try {
            const configSnap = await getDoc(doc(db, tenantPath, 'config', 'bot_settings'));
            if (configSnap.exists() && configSnap.data().instructions) dynamicInstructions = configSnap.data().instructions;
            
            const intSnap = await getDoc(doc(db, tenantPath, 'config', 'integrations'));
            if (intSnap.exists()) integrationsData = intSnap.data();
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
            if (source === 'telegram') bot.sendMessage(chatId, "Диалог окончен.");
            else if (source === 'max') sendToMaxChat(chatId, "Диалог окончен.", integrationsData.max_token);
            return;
        }

        const parts = aiResponse.split(/\[VOICE\]/i);
        let textPart = parts[0]?.trim() || "";
        let voicePart = parts.length > 1 ? parts[1]?.trim() : "";

        if (!textPart && !voicePart) textPart = "Пожалуйста, оставьте ваш номер телефона, специалист свяжется с вами.";

        // ОТПРАВКА ТЕКСТА
        if (textPart) {
            if (source === 'telegram') {
                bot.sendChatAction(chatId, 'typing');
                await new Promise(r => setTimeout(r, Math.min(Math.max(textPart.length * 50, 3000), 8000)));
                await bot.sendMessage(chatId, textPart);
            } else if (source === 'max') {
                await sendToMaxChat(chatId, textPart, integrationsData.max_token);
            }
            await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: textPart, timestamp: Date.now() });
        }

        // ОТПРАВКА ГОЛОСА
        if (voicePart) {
            if (source === 'telegram') {
                bot.sendChatAction(chatId, 'record_voice');
                const voiceBuffer = await generateVoice(voicePart, integrationsData.elevenlabs_api_key);
                if (voiceBuffer) {
                    await bot.sendVoice(chatId, voiceBuffer);
                    await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: `🔊 [Голосовое сообщение]: ${voicePart}`, timestamp: Date.now() });
                } else {
                    const safeVoiceText = voicePart.replace(/\d+/g, '');
                    await bot.sendMessage(chatId, safeVoiceText);
                    await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: safeVoiceText, timestamp: Date.now() });
                }
            } else if (source === 'max') {
                const safeVoiceText = voicePart.replace(/\d+/g, '');
                await sendToMaxChat(chatId, safeVoiceText, integrationsData.max_token);
                await addDoc(collection(db, tenantPath, 'messages'), { chatId, sender: 'ai', text: safeVoiceText, timestamp: Date.now() });
            }
        }

        // ==========================================
        // ЭКСПОРТ В ENVYBOX CRM
        // ==========================================
        
        // ВАЖНО: Если мы только что получили телефон, И он еще не был экспортирован
        if (phoneToSave && !leadData?.crm_exported) {
            try {
                console.log(`[SYSTEM] Начинаем анализ диалога для экспорта. Номер: ${phoneToSave}`);
                
                const fullHistoryText = chatHistory.map(m => `${m.sender === 'user' ? 'КЛИЕНТ' : 'АГЕНТ'}: ${m.text}`).join('\n');
                
                const sumRes = await openai.chat.completions.create({
                    messages: [{ 
                        role: "user", 
                        content: `Проанализируй диалог и сделай строгую выжимку фактов (сумма долга, активы, потребности). Максимум 40 слов. БЕЗ ВЫДУМОК.\n\nДИАЛОГ:\n${fullHistoryText}` 
                    }],
                    model: "deepseek-chat"
                });
                const summary = sumRes.choices[0].message.content;
                
                // Ставим галочку "Экспортировано", чтобы больше не спамить API Envybox
                await updateDoc(leadRef, { summary: summary, crm_exported: true });

                const envyboxApiKey = integrationsData.envybox_api_key;
                
                if (envyboxApiKey) {
                    const payload = {
                        api_key: envyboxApiKey,
                        method: "create",
                        name: userInfo.name || "Лид (Aegis AI)",
                        phone: phoneToSave,
                        comment: `🔥 Квалификация ИИ:\n${summary}\nИсточник: ${source}`
                    };

                    console.log(`[ENVYBOX] Попытка экспорта лида. Данные:`, JSON.stringify(payload));

                    const response = await fetch(`https://crm.envybox.io/api/v1/lead/create`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    
                    const responseText = await response.text();
                    
                    if (response.ok) {
                        console.log(`[ENVYBOX SUCCESS] Лид успешно отправлен! Ответ сервера:`, responseText);
                    } else {
                        console.error(`[ENVYBOX EXPORT FAILED] Статус: ${response.status}. Ответ сервера Envybox:`, responseText);
                    }
                } else {
                    console.log(`[SYSTEM] Экспорт отменен: Ключ Envybox не настроен в CRM.`);
                }

            } catch(e) { console.error("[Summary/Export Error]:", e); }
        }

    } catch (err) { 
        console.error("[CRITICAL BOT ERROR]:", err); 
    }
}

// --- TELEGRAM LISTENER ---
bot.on('message', async (msg) => {
    let text = msg.text;
    if (!text) {
        if (msg.photo) text = "[Фотография]";
        else if (msg.voice) text = "[Голосовое сообщение от клиента]";
        else text = "[Медиафайл]";
    }
    await processAIConversation(String(msg.chat.id), text, 'telegram', { name: msg.from.first_name || 'Клиент TG', username: msg.from.username || 'n/a' });
});

// --- СВЯЗЬ С ОПЕРАТОРОМ (РУЧНОЙ ПЕРЕХВАТ ИЗ НАШЕЙ CRM) ---
onSnapshot(collection(db, tenantPath, 'messages'), async (snap) => {
    snap.docChanges().forEach(async change => {
        const msgData = change.doc.data();
        if (change.type === 'added' && msgData.sender === 'operator' && msgData.timestamp > botStartTime) {
            
            const leadSnap = await getDoc(doc(db, tenantPath, 'leads', msgData.chatId));
            if (leadSnap.exists()) {
                const source = leadSnap.data().source || 'telegram';
                let integrationsData = {};
                const intSnap = await getDoc(doc(db, tenantPath, 'config', 'integrations'));
                if (intSnap.exists()) integrationsData = intSnap.data();

                if (source === 'telegram') {
                    bot.sendMessage(msgData.chatId, msgData.text).catch(e => console.error(e));
                } else if (source === 'max') {
                    sendToMaxChat(msgData.chatId, msgData.text, integrationsData.max_token);
                }
            }
        }
    });
});