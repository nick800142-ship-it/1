import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { Bell, Check, ChevronRight, Globe, Monitor, Moon, Palette, ShieldCheck, Sun, UserRound } from 'lucide-react';
import { LANGUAGES, useLanguage, useTheme, type AccentColor, type ColorMode } from '@/platform';
import { Modal } from '@/components/Modal';
import { supabase } from '@/lib/supabase';

const accentOptions:{value:AccentColor;color:string;zh:string;en:string}[]=[
 {value:'amber',color:'bg-amber-400',zh:'琥珀金',en:'Amber'},
 {value:'blue',color:'bg-blue-500',zh:'海洋藍',en:'Ocean blue'},
 {value:'emerald',color:'bg-emerald-500',zh:'翡翠綠',en:'Emerald'},
 {value:'violet',color:'bg-violet-500',zh:'紫羅蘭',en:'Violet'},
];

export function SettingsPage({sessionUser}:{sessionUser:User}){
 const{t,tr,language,setLanguage}=useLanguage();
 const[user,setUser]=useState<User>(sessionUser);
 useEffect(()=>{
  let active=true;
  void supabase.auth.getUser().then(({data})=>{if(active&&data.user)setUser(data.user)});
  return()=>{active=false};
 },[]);
 const{mode,accent,setMode,setAccent}=useTheme();
 const[langOpen,setLangOpen]=useState(false);
 const[kycOpen,setKycOpen]=useState(false);
 const[alerts,setAlerts]=useState({price:true,dividend:true,listings:false});
 const zh=language==='zh-TW'||language==='zh-CN';
 const appearance=zh?'外觀設定':'Appearance';
 const themeLabel=zh?'顯示模式':'Display mode';
 const colorLabel=zh?'主題顏色':'Accent color';
 const modeOptions:{value:ColorMode;label:string;icon:typeof Sun}[]=[
  {value:'light',label:zh?'淺色':'Light',icon:Sun},
  {value:'dark',label:zh?'深色':'Dark',icon:Moon},
  {value:'system',label:zh?'跟隨系統':'System',icon:Monitor},
 ];
 return <div className="flex flex-col gap-8">
  <header><h1 className="text-3xl font-bold">{t('settings')}</h1><p className="mt-2 text-sm text-slate-400">{t('accountSecurity')}</p></header>
  <Group icon={<UserRound/>} title={zh?'帳號資訊':'Account information'}><div className="flex flex-col gap-4 p-5"><Info label="Email" value={user.email??'—'}/><Info label="User ID" value={user.id}/></div></Group>
  <button onClick={()=>setKycOpen(true)} className="flex w-full items-center gap-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-left hover:bg-emerald-500/15"><span className="rounded-xl bg-emerald-500/15 p-3 text-emerald-400"><ShieldCheck className="h-7 w-7"/></span><div className="flex-1"><p className="text-xs uppercase tracking-wider text-emerald-400">{tr('identity')}</p><h2 className="mt-1 text-lg font-bold text-white">{t('kycPassed')}</h2><p className="mt-1 text-sm text-slate-400">{tr('level')} 2 · {tr('verifiedDate')} 2026-07-18</p></div><ChevronRight className="h-5 w-5 text-slate-400"/></button>
  <Group icon={<Palette/>} title={appearance}>
   <div className="flex flex-col gap-4 p-5"><div><p className="font-medium">{themeLabel}</p><p className="mt-1 text-xs text-slate-500">{zh?'立即套用到整個網站':'Applied instantly across the website'}</p></div><div className="grid grid-cols-3 gap-2">{modeOptions.map(({value,label,icon:Icon})=><button key={value} onClick={()=>setMode(value)} aria-pressed={mode===value} className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition ${mode===value?'border-amber-400 bg-amber-400/10 text-amber-300':'border-slate-700 text-slate-400 hover:bg-slate-800'}`}><Icon className="h-4 w-4"/>{label}</button>)}</div></div>
   <div className="flex flex-col gap-4 p-5"><div><p className="font-medium">{colorLabel}</p><p className="mt-1 text-xs text-slate-500">{zh?'選擇按鈕、連結與焦點的顏色':'Choose the color for buttons, links, and focus states'}</p></div><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{accentOptions.map(option=><button key={option.value} onClick={()=>setAccent(option.value)} aria-pressed={accent===option.value} className={`flex items-center gap-2 rounded-xl border px-3 py-3 text-sm transition ${accent===option.value?'border-amber-400 bg-amber-400/10 text-white':'border-slate-700 text-slate-400 hover:bg-slate-800'}`}><span className={`h-4 w-4 rounded-full ${option.color}`}/>{zh?option.zh:option.en}{accent===option.value&&<Check className="ml-auto h-4 w-4"/>}</button>)}</div></div>
  </Group>
  <Group icon={<Globe/>} title={tr('preferences')}><button onClick={()=>setLangOpen(true)} className="flex w-full items-center justify-between p-5 text-left hover:bg-slate-800/40"><div><p className="font-medium">{t('language')}</p><p className="mt-1 text-xs text-slate-500">{tr('changeLanguage')}</p></div><span className="flex items-center gap-2 text-sm text-amber-300">{LANGUAGES.find(x=>x[0]===language)?.[1]}<ChevronRight className="h-4 w-4"/></span></button></Group>
  <Group icon={<Bell/>} title={tr('notifications')}>{Object.entries(alerts).map(([k,v])=><div key={k} className="flex items-center justify-between p-5"><div><p className="font-medium">{tr(k)}</p><p className="mt-1 text-xs text-slate-500">{tr('receiveAlerts')}</p></div><button aria-label={tr(k)} role="switch" aria-checked={v} onClick={()=>setAlerts(a=>({...a,[k]:!v}))} className={`relative h-6 w-11 rounded-full ${v?'bg-amber-400':'bg-slate-700'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${v?'left-6':'left-1'}`}/></button></div>)}</Group>
  {langOpen&&<Modal open title={t('language')} onClose={()=>setLangOpen(false)}><div className="grid gap-2 sm:grid-cols-2">{LANGUAGES.map(([code,label])=><button key={code} onClick={()=>{setLanguage(code);setLangOpen(false)}} className={`flex items-center justify-between rounded-xl border p-3 text-left ${language===code?'border-amber-400 bg-amber-400/10':'border-slate-700 hover:bg-slate-800'}`}>{label}{language===code&&<Check className="h-4 w-4 text-amber-300"/>}</button>)}</div></Modal>}
  {kycOpen&&<Modal open title={tr('identity')} onClose={()=>setKycOpen(false)}><div className="flex flex-col gap-4"><Info label={tr('status')} value={t('kycPassed')}/><Info label={tr('level')} value={`2 · ${tr('investor')}`}/><Info label={tr('verifiedDate')} value="2026-07-18"/><Info label="Reference" value="KYC-89204-AU"/></div></Modal>}
 </div>
}
function Group({icon,title,children}:{icon:React.ReactNode;title:string;children:React.ReactNode}){return <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"><header className="flex items-center gap-2 border-b border-slate-800 p-4 text-amber-300">{icon}<h2 className="font-bold text-white">{title}</h2></header><div className="divide-y divide-slate-800">{children}</div></section>}
function Info({label,value}:{label:string;value:string}){return <p className="flex justify-between border-b border-slate-800 pb-3 text-sm"><span className="text-slate-400">{label}</span><b>{value}</b></p>}
