import { useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { LogOut } from 'lucide-react';
import { NAV_ITEMS } from '@/nav';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/platform';
import type { PageKey } from '@/nav';

type Props={current:PageKey;onNavigate:(p:PageKey)=>void;user:User};
export function Sidebar({current,onNavigate,user}:Props){
 const[signingOut,setSigningOut]=useState(false);
 const handleSignOut=async()=>{
  if(signingOut)return;
  setSigningOut(true);

  const timeout=new Promise<void>((resolve)=>window.setTimeout(resolve,1500));
  try{
   await Promise.race([
    supabase.auth.signOut({scope:'local'}).then(()=>undefined),
    timeout,
   ]);
  }finally{
   for(let index=localStorage.length-1;index>=0;index-=1){
    const key=localStorage.key(index);
    if(key?.startsWith('sb-')&&key.endsWith('-auth-token'))localStorage.removeItem(key);
   }
   sessionStorage.clear();
   window.location.href='/';
  }
 };
 return <><aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-800 bg-slate-950/95 backdrop-blur lg:flex"><Inner current={current} onNavigate={onNavigate} user={user} onSignOut={handleSignOut} signingOut={signingOut}/></aside><nav aria-label="Mobile navigation" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-800 bg-slate-950/95 p-2 backdrop-blur lg:hidden"><Items current={current} onNavigate={onNavigate} mobile/><button type="button" onClick={handleSignOut} disabled={signingOut} aria-label="登出" className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[11px] font-medium text-slate-400 hover:bg-slate-900 hover:text-white disabled:opacity-50"><LogOut className="size-5"/>{signingOut?'登出中…':'登出'}</button></nav></>
}
function Items({current,onNavigate,mobile=false}:{current:PageKey;onNavigate:(p:PageKey)=>void;mobile?:boolean}){const{t}=useLanguage();return <>{NAV_ITEMS.map(item=>{const Icon=item.icon;const active=current===item.key;return <button key={item.key} onClick={()=>onNavigate(item.key)} aria-current={active?'page':undefined} className={`${mobile?'flex-1 flex-col justify-center text-[11px]':'w-full'} flex items-center gap-2 rounded-xl px-3 py-2.5 font-medium transition ${active?'bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20':'text-slate-400 hover:bg-slate-900 hover:text-white'}`}><Icon className="size-5"/>{t(item.key)}</button>})}</>}
function Inner({user,onSignOut,signingOut,...props}:Props&{onSignOut:()=>Promise<void>;signingOut:boolean}){const name=user.user_metadata?.full_name||user.email||'Google User';return <><div className="flex items-center gap-3 px-6 py-6"><div className="flex size-10 items-center justify-center rounded-xl bg-amber-400 font-black text-slate-950">R</div><div><p className="font-bold text-white">RWA Ledger</p><p className="text-xs text-slate-500">Tokenized property</p></div></div><nav className="flex flex-1 flex-col gap-1 px-3"><Items {...props}/></nav><div className="border-t border-slate-800 p-4"><div className="flex flex-col gap-3 rounded-xl bg-slate-900 p-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{name}</p><p className="truncate text-xs text-slate-500">{user.email}</p></div><button type="button" onClick={onSignOut} disabled={signingOut} className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"><LogOut className="size-4"/>{signingOut?'登出中…':'登出'}</button></div></div></>}
