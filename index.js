import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, addDoc, updateDoc } from 'firebase/firestore';
import { 
  MessageSquare, Send, Bot, User, Zap, ArrowRight, 
  CheckCircle2, AlertTriangle, Phone, Calendar, Clock, FileText, Info, PhoneCall, Copy, Mic, Lock
} from 'lucide-react';

// --- ИНИЦИАЛИЗАЦИЯ FIREBASE (ТВОИ КЛЮЧИ) ---
const firebaseConfig = {
  apiKey: "AIzaSyDCsU0EgUUByrAK_CG3UdIxQ7DTwhRkhvc",
  authDomain: "aegis-crm-26ca9.firebaseapp.com",
  projectId: "aegis-crm-26ca9",
  storageBucket: "aegis-crm-26ca9.firebasestorage.app",
  messagingSenderId: "438781854337",
  appId: "1:438781854337:web:32dc926ebe06f15eab0380"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const appId = 'aegis-leads-app';

// --- НАСТРОЙКА БЕЗОПАСНОСТИ ---
const SECRET_PIN = '7777'; // Твой секретный ПИН-код для входа

const formatDate = (timestamp) => {
  if (!timestamp) return 'Нет данных';
  const d = new Date(timestamp);
  return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

const safeText = (val, fallback = '') => val ? String(val) : fallback;

export default function App() {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [accessError, setAccessError] = useState(null);
  const [copied, setCopied] = useState(false);
  
  // Состояния для ПИН-кода
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);
  
  const [rawLeads, setRawLeads] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  
  const scrollRef = useRef(null);

  // --- ЗАЩИТА ОТ КОПИРОВАНИЯ И ПРОСМОТРА КОДА ---
  useEffect(() => {
    const handleContextMenu = (e) => e.preventDefault(); // Блокировка правой кнопки
    const handleKeyDown = (e) => {
      // Блокировка F12, Ctrl+Shift+I, Ctrl+U
      if (e.key === 'F12' || 
         (e.ctrlKey && e.shiftKey && e.key === 'I') || 
         (e.ctrlKey && e.key === 'u') ||
         (e.ctrlKey && e.key === 'U')) {
        e.preventDefault();
      }
    };

    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('keydown', handleKeyDown);
    
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const copyId = () => {
    navigator.clipboard.writeText(appId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // АВТОРИЗАЦИЯ
  useEffect(() => {
    if (!auth) return;
    const initAuth = async () => {
      try {
        await signInAnonymously(auth);
      } catch (e) { 
        setAccessError("Ошибка авторизации: " + e.message); 
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // ЗАГРУЗКА ДАННЫХ
  useEffect(() => {
    if (!db || !user || !isAuthenticated) return; // Не грузим данные, пока не введен ПИН
    
    try {
      const lRef = collection(db, 'artifacts', appId, 'public', 'data', 'leads');
      const mRef = collection(db, 'artifacts', appId, 'public', 'data', 'messages');

      const unsubL = onSnapshot(lRef, (s) => setRawLeads(s.docs.map(d => ({ id: d.id, ...d.data() }))), 
        (e) => setAccessError("Доступ к лидам ограничен: " + e.message));
        
      const unsubM = onSnapshot(mRef, (s) => setMessages(s.docs.map(d => ({ id: d.id, ...d.data() }))),
        (e) => console.error("Ошибка загрузки сообщений:", e.message));

      return () => { unsubL(); unsubM(); };
    } catch (err) {
      console.error("Firestore Init Error:", err);
      setAccessError("Ошибка базы данных: " + err.message);
    }
  }, [user, isAuthenticated]);

  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, selectedId]);

  // ОБРАБОТКА ДАННЫХ
  const leads = rawLeads.map(l => {
    const leadMsgs = messages.filter(m => String(m.chatId) === String(l.id)).sort((a,b) => a.timestamp - b.timestamp);
    const firstMsgDate = leadMsgs.length > 0 ? leadMsgs[0].timestamp : l.updatedAt;
    const lastMsgDate = leadMsgs.length > 0 ? leadMsgs[leadMsgs.length - 1].timestamp : l.updatedAt;
    
    let phone = l.phone;
    if (!phone) {
      const phoneRegex = /(?:\+7|8|7)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/;
      const msgWithPhone = leadMsgs.find(m => m.sender === 'user' && phoneRegex.test(m.text));
      if (msgWithPhone) phone = msgWithPhone.text.match(phoneRegex)[0];
    }

    return { ...l, firstMsgDate, lastMsgDate, phone, msgCount: leadMsgs.length };
  }).sort((a,b) => (b.lastMsgDate || 0) - (a.lastMsgDate || 0));

  const activeMessages = messages.filter(m => String(m.chatId) === String(selectedId)).sort((a, b) => a.timestamp - b.timestamp);
  const activeLead = leads.find(l => l.id === selectedId);

  // ЛОГИКА ВХОДА
  const handleLogin = (e) => {
    e.preventDefault();
    if (pin === SECRET_PIN) {
      setIsAuthenticated(true);
      setPinError(false);
    } else {
      setPinError(true);
      setPin('');
    }
  };

  // ОТПРАВКА СООБЩЕНИЯ И ПЕРЕХВАТ
  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || !selectedId || isSending || !user) return;
    setIsSending(true);
    const text = input; setInput('');
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', selectedId), {
        status: 'operator_active', updatedAt: Date.now()
      });
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'messages'), {
        chatId: String(selectedId), sender: 'operator', text: text, timestamp: Date.now()
      });
    } catch (err) { console.error("Send Error:", err); } 
    finally { setIsSending(false); }
  };

  const takeOverControl = async () => {
    if (!selectedId) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'leads', selectedId), {
        status: 'operator_active', updatedAt: Date.now()
      });
    } catch (err) { console.error("Takeover Error:", err); }
  };

  // ЭКРАН ВХОДА (С ПИН-КОДОМ)
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 text-left font-sans select-none">
        <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl max-w-sm w-full text-center border-b-8 border-blue-600">
           <div className="w-20 h-20 bg-slate-100 rounded-3xl mx-auto flex items-center justify-center mb-8 shadow-inner">
              <Lock size={36} className="text-slate-400" />
           </div>
           <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase leading-none text-center">Aegis CRM</h1>
           <p className="text-slate-400 font-bold uppercase text-[10px] tracking-[0.2em] mt-3 mb-8 text-center">Защищенный доступ</p>
           
           {accessError && <p className="text-xs text-red-500 font-bold mb-4 bg-red-50 p-3 rounded-xl break-words">{accessError}</p>}
           
           <form onSubmit={handleLogin} className="space-y-4">
             <div>
               <input 
                 type="password" 
                 maxLength={4}
                 value={pin}
                 onChange={(e) => {
                   setPin(e.target.value.replace(/\D/g, '')); // Только цифры
                   setPinError(false);
                 }}
                 placeholder="••••"
                 className={`w-full text-center text-3xl tracking-[1em] font-black p-4 bg-slate-50 border-2 rounded-2xl outline-none transition-all ${pinError ? 'border-red-400 bg-red-50 text-red-500' : 'border-slate-200 focus:border-blue-500'}`}
               />
               {pinError && <p className="text-[10px] text-red-500 font-bold uppercase tracking-widest mt-2 animate-pulse">Неверный код доступа</p>}
             </div>
             <button 
               type="submit"
               disabled={!user || pin.length < 4} 
               className="w-full bg-blue-600 text-white py-5 rounded-2xl font-black uppercase text-xs tracking-widest shadow-lg shadow-blue-500/30 flex items-center justify-center gap-3 disabled:opacity-50 disabled:grayscale transition-all active:scale-95"
             >
               Войти <ArrowRight size={18}/>
             </button>
           </form>
        </div>
        <div className="mt-8 opacity-30 text-[10px] text-white font-bold tracking-widest uppercase flex items-center gap-2">
           <Lock size={10} /> Система защищена
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      
      {/* 1. ЛЕВАЯ КОЛОНКА */}
      <aside className="w-80 border-r border-slate-200 bg-white flex flex-col shrink-0 z-20 select-none">
        <header className="h-20 flex items-center px-6 border-b shrink-0 gap-3">
           <div className="p-2 bg-blue-600 rounded-xl text-white"><MessageSquare size={18}/></div>
           <h2 className="font-black text-xs uppercase tracking-widest">Все лиды ({leads.length})</h2>
        </header>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
           {leads.map(l => (
             <button key={l.id} onClick={() => setSelectedId(l.id)} className={`w-full p-4 rounded-2xl text-left border-2 transition-all ${selectedId === l.id ? 'bg-blue-50 border-blue-500 shadow-sm' : 'bg-white border-transparent hover:border-slate-100'}`}>
                <div className="flex justify-between items-start mb-1">
                   <p className="font-black text-sm truncate pr-2 text-slate-800">{safeText(l.name || 'Неизвестный')}</p>
                   <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${l.status === 'operator_active' ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} title={l.status === 'operator_active' ? 'Диалог с оператором' : 'Общается с ботом'} />
                </div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">@{safeText(l.username)}</div>
                <div className="text-[10px] font-medium text-slate-500 flex justify-between">
                   <span>{l.msgCount} сообщ.</span>
                   <span>{new Date(l.lastMsgDate).toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'})}</span>
                </div>
             </button>
           ))}
        </div>
      </aside>

      {/* 2. ЦЕНТРАЛЬНАЯ КОЛОНКА */}
      <main className="flex-1 flex flex-col bg-[#f8fafc] border-r border-slate-200 relative">
         {selectedId ? (
           <>
             <header className="h-20 border-b flex items-center px-8 bg-white/50 backdrop-blur-sm shrink-0 select-none">
               <h2 className="font-black text-lg text-slate-800 uppercase tracking-tight">Диалог</h2>
             </header>
             <div className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar">
                {activeMessages.map((m, i) => {
                  const isVoice = typeof m.text === 'string' && m.text.includes('🔊 [Голосовое сообщение]');
                  const displayText = isVoice ? m.text.replace('🔊 [Голосовое сообщение]:', '').trim() : safeText(m.text);
                  
                  return (
                    <div key={i} className={`flex ${m.sender === 'user' ? 'justify-start' : 'justify-end'}`}>
                       <div className={`max-w-[80%] p-5 rounded-3xl shadow-sm text-left ${
                         m.sender === 'user' 
                         ? 'bg-white border border-slate-200 text-slate-800 rounded-bl-none' 
                         : m.sender === 'ai' 
                           ? (isVoice ? 'bg-indigo-100 border border-indigo-200 text-indigo-900 rounded-br-none shadow-md' : 'bg-blue-50 border border-blue-100 text-blue-900 rounded-br-none italic')
                           : 'bg-slate-800 text-white rounded-br-none'
                       }`}>
                          <div className="text-[9px] font-black uppercase tracking-widest mb-2 opacity-50 flex items-center gap-1.5 select-none">
                             {m.sender === 'user' ? <User size={10}/> : <Bot size={10}/>}
                             {m.sender === 'user' ? 'Клиент' : m.sender === 'operator' ? 'Вы' : 'Бот'}
                             {isVoice && <span className="ml-auto flex items-center gap-1 text-indigo-600 bg-indigo-200/50 px-2 py-0.5 rounded-full"><Mic size={10}/> Голосовое</span>}
                          </div>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap">{displayText}</p>
                          <div className="text-[9px] mt-2 font-bold opacity-40 text-right select-none">{new Date(m.timestamp).toLocaleTimeString('ru-RU')}</div>
                       </div>
                    </div>
                  );
                })}
                <div ref={scrollRef} />
             </div>
             <div className="p-6 bg-white border-t border-slate-200 select-none">
               <form onSubmit={sendMessage} className="flex gap-3">
                  <input value={input} onChange={e => setInput(e.target.value)} className="flex-1 p-4 bg-slate-50 border border-slate-200 rounded-2xl outline-none focus:border-blue-500 focus:bg-white transition-all font-medium text-sm" placeholder="Ответить клиенту (перехватит управление)..." />
                  <button disabled={isSending || !input.trim()} className="bg-blue-600 text-white px-6 rounded-2xl hover:bg-blue-700 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center"><Send size={20}/></button>
               </form>
             </div>
           </>
         ) : (
           <div className="flex-1 flex flex-col items-center justify-center text-slate-300 gap-6 select-none">
              <MessageSquare size={64} strokeWidth={1} />
              <p className="text-xs font-black uppercase tracking-widest">Выберите чат слева</p>
           </div>
         )}
      </main>

      {/* 3. ПРАВАЯ КОЛОНКА */}
      <aside className="w-[340px] bg-white flex flex-col shrink-0 overflow-y-auto custom-scrollbar">
        {activeLead ? (
          <div className="p-6 space-y-6">
            
            <div className="text-center pb-6 border-b border-slate-100 select-none">
              <div className="w-20 h-20 bg-gradient-to-tr from-blue-600 to-indigo-500 rounded-full mx-auto flex items-center justify-center text-white shadow-lg shadow-blue-500/30 mb-4">
                <User size={32} />
              </div>
              <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight leading-tight">{safeText(activeLead.name)}</h2>
              <p className="text-xs font-bold text-blue-600 uppercase tracking-widest mt-2 flex items-center justify-center gap-1"><Zap size={12}/> Telegram Lead</p>
            </div>

            <div className={`p-4 rounded-2xl flex items-start gap-3 border select-none ${activeLead.status === 'operator_active' ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : 'bg-amber-50 border-amber-100 text-amber-800'}`}>
               <Info className="shrink-0 mt-0.5" size={18} />
               <div>
                 <p className="text-xs font-black uppercase tracking-wider mb-1">{activeLead.status === 'operator_active' ? 'Контроль у оператора' : 'Контроль у ИИ'}</p>
                 <p className="text-[11px] leading-relaxed opacity-80">{activeLead.status === 'operator_active' ? 'Бот молчит. Вы ведете диалог с клиентом.' : 'Бот ведет автоматический диалог. Напишите сообщение, чтобы перехватить.'}</p>
               </div>
            </div>

            {activeLead.status !== 'operator_active' && (
              <button onClick={takeOverControl} className="w-full py-3 bg-slate-900 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:bg-slate-800 active:scale-95 transition-all shadow-md shadow-slate-900/10 select-none">
                Перехватить управление
              </button>
            )}

            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2 select-none"><FileText size={14}/> Резюме ИИ</h3>
              <div className="bg-slate-50 border border-slate-100 p-4 rounded-2xl">
                <p className="text-sm font-medium text-slate-700 leading-relaxed italic">
                  {activeLead.summary ? `"${safeText(activeLead.summary)}"` : 'Резюме формируется...'}
                </p>
              </div>
            </div>

            <div>
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2 select-none"><Phone size={14}/> Контакты</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider select-none">Username</span>
                  <span className="text-sm font-black text-slate-800">@{safeText(activeLead.username)}</span>
                </div>
                {activeLead.phone && (
                  <div className="flex items-center justify-between p-3 bg-blue-50 rounded-xl border border-blue-100">
                    <span className="text-xs font-bold text-blue-600 uppercase tracking-wider select-none">Телефон</span>
                    <a href={`tel:${activeLead.phone}`} className="text-sm font-black text-blue-800 flex items-center gap-2 hover:underline">
                      {safeText(activeLead.phone)} <PhoneCall size={14} />
                    </a>
                  </div>
                )}
              </div>
            </div>

            <div className="select-none">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3 flex items-center gap-2"><Calendar size={14}/> Хронология</h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-500 flex items-center gap-1.5"><Calendar size={12}/> Первое обращение</span>
                  <span className="font-black text-slate-700">{formatDate(activeLead.firstMsgDate)}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-500 flex items-center gap-1.5"><Clock size={12}/> Последняя активность</span>
                  <span className="font-black text-slate-700">{formatDate(activeLead.lastMsgDate)}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-slate-500 flex items-center gap-1.5"><MessageSquare size={12}/> Сообщений в чате</span>
                  <span className="font-black text-slate-700">{activeLead.msgCount} шт.</span>
                </div>
              </div>
            </div>

          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-300 p-8 text-center select-none">
             <Info size={48} className="mb-4 opacity-50" />
             <p className="text-xs font-black uppercase tracking-widest">Профиль клиента будет отображен здесь</p>
          </div>
        )}
      </aside>

    </div>
  );
}