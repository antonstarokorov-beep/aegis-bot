import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, doc, addDoc, updateDoc, query, orderBy, limit } from 'firebase/firestore';
import { 
  MessageSquare, Send, Bot, User, Phone, 
  ShieldCheck, Zap, Activity, Search, 
  Bell, Lock, UserCircle, ArrowRight, Loader2,
  Clock, MessageCircle, PhoneCall, Shield, CheckCircle2,
  Archive, Trash2, ExternalLink, Hash, Info, Copy, Check
} from 'lucide-react';

// --- ИНИЦИАЛИЗАЦИЯ ТЕХНИЧЕСКОГО ОКРУЖЕНИЯ ---
const getSafeEnv = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
  let fbCfg = g.__firebase_config;
  if (typeof fbCfg === 'string') {
    try { fbCfg = JSON.parse(fbCfg); } catch (e) { fbCfg = null; }
  }
  
  // Получаем системный ID. Именно его нужно вставить в Render.com в переменную CRM_CUSTOM_APP_ID
  const rawId = g.__app_id || 'aegis-leads-app';
  const cleanId = String(rawId).split('/').join('_');
  
  return {
    firebaseConfig: fbCfg,
    appId: cleanId,
    token: g.__initial_auth_token || null
  };
};

const env = getSafeEnv();
const app = env.firebaseConfig ? initializeApp(env.firebaseConfig) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getFirestore(app) : null;

const safe = (val, fallback = '') => {
  if (val === null || val === undefined) return fallback;
  if (React.isValidElement(val)) return val;
  if (typeof val === 'object') {
    if (val.seconds) return new Date(val.seconds * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (val instanceof Date) return val.toLocaleTimeString('ru-RU');
    return fallback;
  }
  return String(val);
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const [leads, setLeads] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  
  const scrollRef = useRef(null);

  const copyId = () => {
    const el = document.createElement('textarea');
    el.value = env.appId;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    if (!auth) return;
    const runAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (e) { console.error("Auth Fail:", e); }
    };
    runAuth();
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!db || !user || !authReady) return;

    const leadsRef = collection(db, 'artifacts', env.appId, 'public', 'data', 'leads');
    const msgsRef = collection(db, 'artifacts', env.appId, 'public', 'data', 'messages');

    const unsubLeads = onSnapshot(leadsRef, (s) => {
      setLeads(s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    }, (e) => console.error("Leads Sync Error:", e));

    const unsubMsgs = onSnapshot(msgsRef, (s) => {
      setMessages(s.docs.map(d => ({ id: d.id, ...d.data() })));
    }, (e) => console.error("Msgs Sync Error:", e));

    return () => { unsubLeads(); unsubMsgs(); };
  }, [user, authReady]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, selectedLeadId]);

  const activeMessages = messages
    .filter(m => String(m.chatId) === String(selectedLeadId))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const activeLead = leads.find(l => l.id === selectedLeadId);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!input.trim() || !selectedLeadId || isSending) return;
    setIsSending(true);
    const text = input; setInput('');

    try {
      await updateDoc(doc(db, 'artifacts', env.appId, 'public', 'data', 'leads', selectedLeadId), {
        status: 'operator_active',
        updatedAt: Date.now()
      });

      await addDoc(collection(db, 'artifacts', env.appId, 'public', 'data', 'messages'), {
        chatId: String(selectedLeadId),
        sender: 'operator',
        text: text,
        timestamp: Date.now()
      });
    } catch (err) { console.error("Send Error:", err); }
    finally { setIsSending(false); }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 font-sans">
        <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl max-w-sm w-full text-center border-4 border-blue-500/10 mb-6">
           <div className="w-20 h-20 bg-blue-600 rounded-3xl mx-auto flex items-center justify-center shadow-xl shadow-blue-500/30 mb-8">
              <Bot size={40} className="text-white" />
           </div>
           <h1 className="text-3xl font-black text-slate-800 tracking-tighter uppercase leading-none">Aegis AI</h1>
           <p className="text-slate-400 font-bold uppercase text-[10px] tracking-[0.2em] mt-2 mb-10 text-center">Leads Control Center</p>
           
           <button 
             onClick={() => setIsAuthenticated(true)}
             disabled={!authReady}
             className="w-full bg-[#1a2b4c] text-white py-4 rounded-2xl font-black uppercase text-xs tracking-widest shadow-lg active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50"
           >
             {authReady ? 'Войти в систему' : 'Подключение...'} <ArrowRight size={18}/>
           </button>
        </div>
        
        {/* КАРТОЧКА С SYNC ID */}
        <div className="max-w-sm w-full bg-blue-600 p-6 rounded-[2rem] shadow-2xl shadow-blue-500/20 text-white text-left animate-in slide-in-from-bottom-4 duration-500">
           <div className="flex items-center justify-between mb-4">
              <span className="text-[10px] font-black uppercase tracking-widest bg-blue-700 px-3 py-1 rounded-full flex items-center gap-2">
                 <Zap size={12} fill="currentColor"/> Sync ID для Render.com
              </span>
           </div>
           <p className="text-xs font-bold leading-relaxed mb-4 opacity-90 text-left">
              Скопируйте этот код и вставьте его в поле <code className="bg-blue-800 px-1 rounded">CRM_CUSTOM_APP_ID</code> в настройках Render:
           </p>
           <div 
             onClick={copyId}
             className="bg-blue-900/40 p-4 rounded-2xl flex items-center justify-between cursor-pointer hover:bg-blue-900/60 transition-all border border-blue-400/20 active:scale-95"
           >
              <code className="text-sm font-mono text-blue-100 break-all select-all font-bold">
                 {env.appId}
              </code>
              <div className="shrink-0 ml-4 text-blue-400">
                 {copied ? <Check size={18} className="text-green-400" /> : <Copy size={18} />}
              </div>
           </div>
           {copied && <p className="text-[10px] text-green-300 font-bold uppercase mt-2 text-center">Скопировано!</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900 overflow-hidden text-left">
      <aside className="w-80 lg:w-96 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <header className="h-20 flex items-center px-6 border-b bg-white shrink-0">
           <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-600 rounded-lg text-white"><MessageSquare size={18}/></div>
              <h2 className="font-black text-sm uppercase tracking-tighter">Входящие заявки</h2>
           </div>
        </header>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
           {leads.map(lead => (
             <button 
               key={lead.id}
               onClick={() => setSelectedLeadId(lead.id)}
               className={`w-full p-4 rounded-3xl transition-all border text-left flex flex-col gap-2 ${
                 selectedLeadId === lead.id 
                 ? 'bg-blue-600 border-blue-500 text-white shadow-xl shadow-blue-600/20' 
                 : 'bg-white border-slate-100 hover:border-slate-200 hover:bg-slate-50'
               }`}
             >
                <div className="flex justify-between items-start">
                   <div className="font-black text-xs uppercase truncate pr-4">{safe(lead.name || 'Новый лид')}</div>
                   <div className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase ${
                     selectedLeadId === lead.id ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-500'
                   }`}>
                      {safe(lead.status === 'operator_active' ? 'В работе' : 'ИИ')}
                   </div>
                </div>
                {lead.summary && (
                  <p className={`text-[11px] leading-relaxed line-clamp-2 italic ${selectedLeadId === lead.id ? 'text-blue-100' : 'text-slate-500'}`}>
                     "{safe(lead.summary)}"
                  </p>
                )}
                <div className={`flex justify-between items-center mt-1 text-[9px] font-bold uppercase tracking-widest ${
                  selectedLeadId === lead.id ? 'text-blue-200' : 'text-slate-400'
                }`}>
                   <span className="flex items-center gap-1"><Hash size={10}/>{lead.id}</span>
                   <span>{safe(lead.updatedAt)}</span>
                </div>
             </button>
           ))}
        </div>
      </aside>

      <main className="flex-1 flex flex-col bg-white overflow-hidden relative">
         {selectedLeadId ? (
           <>
             <header className="h-20 border-b flex items-center justify-between px-8 bg-white shrink-0 z-10 shadow-sm">
                <div className="flex items-center gap-4">
                   <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 font-bold">
                      <User size={20}/>
                   </div>
                   <div className="leading-none text-left">
                      <h3 className="text-lg font-black text-slate-800 tracking-tighter uppercase">{safe(activeLead?.name)}</h3>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1 flex items-center gap-1.5 text-left">
                         <Zap size={10} className="text-amber-500"/> Лид из Telegram • @{safe(activeLead?.username)}
                      </p>
                   </div>
                </div>
             </header>

             <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 flex flex-col bg-slate-50/30">
                   <div className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar">
                      {activeMessages.map((m, i) => (
                        <div key={i} className={`flex ${m.sender === 'user' ? 'justify-start' : 'justify-end'}`}>
                           <div className={`max-w-[80%] p-5 rounded-[2rem] shadow-sm text-left ${
                             m.sender === 'user' 
                             ? 'bg-white border border-slate-200 text-slate-800 rounded-bl-none' 
                             : m.sender === 'ai'
                               ? 'bg-blue-50 border border-blue-100 text-blue-800 rounded-br-none italic'
                               : 'bg-[#1a2b4c] text-white rounded-br-none shadow-blue-900/10'
                           }`}>
                              <div className="text-[9px] font-black uppercase tracking-widest mb-2 opacity-40 flex items-center gap-1.5 text-left">
                                 {m.sender === 'user' ? 'Клиент' : m.sender === 'operator' ? 'Вы' : 'AI Бот'}
                              </div>
                              <p className="text-sm leading-relaxed whitespace-pre-wrap font-medium">{safe(m.text)}</p>
                              <div className="text-[8px] font-bold mt-2 opacity-20 text-right uppercase">{safe(m.timestamp)}</div>
                           </div>
                        </div>
                      ))}
                      <div ref={scrollRef} />
                   </div>

                   <form onSubmit={handleSend} className="p-6 bg-white border-t flex gap-4 shrink-0 shadow-2xl z-10">
                      <input 
                        value={input} 
                        onChange={e => setInput(e.target.value)}
                        className="flex-1 p-4 bg-slate-100 border-none rounded-2xl outline-none focus:ring-4 focus:ring-blue-500/10 transition-all font-bold text-sm"
                        placeholder="Напишите клиенту..."
                      />
                      <button 
                        disabled={isSending}
                        className="bg-blue-600 hover:bg-blue-700 text-white w-14 h-14 rounded-2xl flex items-center justify-center shadow-xl shadow-blue-600/30 transition-all active:scale-90 disabled:opacity-50"
                      >
                         <Send size={24}/>
                      </button>
                   </form>
                </div>
             </div>
           </>
         ) : (
           <div className="flex-1 flex flex-col items-center justify-center text-slate-300 gap-6 grayscale opacity-20">
              <Bot size={120} strokeWidth={1} className="animate-pulse" />
              <div className="text-center">
                 <h2 className="text-2xl font-black uppercase tracking-widest leading-none">Aegis AI Leads Hub</h2>
                 <p className="text-xs font-bold mt-2">Выберите чат слева</p>
              </div>
           </div>
         )}
      </main>
    </div>
  );
}