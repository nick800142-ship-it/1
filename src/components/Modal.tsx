import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({open,onClose,title,children,wide=false,centered=false,closeLabel="Close"}:{open:boolean;onClose:()=>void;title:string;children:ReactNode;wide?:boolean;centered?:boolean;closeLabel?:string}){
 useEffect(()=>{if(!open)return;const fn=(e:KeyboardEvent)=>e.key==='Escape'&&onClose();document.addEventListener('keydown',fn);return()=>document.removeEventListener('keydown',fn)},[open,onClose]);
 if(!open)return null;
 // z-[60] 讓彈窗蓋在 z-50 的手機底部導覽列之上，否則操作按鈕會被導覽列遮住。
 return <div className={`fixed inset-0 z-[60] flex max-w-full justify-center overflow-x-hidden ${centered?'items-center p-4':'items-end p-0 sm:items-center sm:px-6 sm:py-6'}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={onClose}>
  <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" />
  <div className={`relative max-h-[92dvh] w-full overflow-x-hidden overflow-y-auto border border-slate-700 bg-slate-900 shadow-2xl ${centered?'max-w-lg rounded-3xl':`max-w-full rounded-t-3xl sm:rounded-3xl ${wide?'sm:max-w-4xl':'sm:max-w-lg'}`}`} onMouseDown={e=>e.stopPropagation()}>
   <header className="sticky top-0 z-10 flex min-w-0 items-center justify-between gap-3 border-b border-slate-700 bg-slate-900/95 px-4 py-4 backdrop-blur sm:px-5">
    <h2 id="modal-title" className="min-w-0 break-words text-lg font-bold text-white">{title}</h2><button onClick={onClose} aria-label={closeLabel} className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"><X className="h-5 w-5" /></button>
   </header><div className="min-w-0 break-words p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6">{children}</div>
  </div>
 </div>
}

export function Notice({message,tone='success'}:{message:string;tone?:'success'|'error'|'pending'}){return <p role="status" className={`rounded-xl border px-4 py-3 text-sm ${tone==='success'?'border-emerald-500/30 bg-emerald-500/10 text-emerald-300':tone==='pending'?'border-amber-500/30 bg-amber-500/10 text-amber-200':'border-red-500/30 bg-red-500/10 text-red-300'}`}>{message}</p>}
