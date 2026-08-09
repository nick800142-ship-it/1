import { Copy, CheckCircle2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { formatUSDT, useLanguage, usePlatform } from '@/platform';

const ADDRESS='0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

export function WalletPage(){
 const {t,tr}=useLanguage();
 const {balance,holdings,transactions,assets,loading}=usePlatform();
 const [copied,setCopied]=useState(false);
 const assetFor=(id:string)=>assets.find(asset=>asset.id===id);
 const holdingsValue=holdings.reduce((sum,holding)=>sum+holding.tokens*(assetFor(holding.assetId)?.price??0),0);
 const copy=async()=>{await navigator.clipboard.writeText(ADDRESS);setCopied(true);setTimeout(()=>setCopied(false),1500)};
 return <div className="flex flex-col gap-8">
  <header><h1 className="text-3xl font-bold">{t('wallet')}</h1><p className="mt-2 text-sm text-slate-400">Sandbox USDT · 流水帳精準計算</p></header>
  <section className="rounded-3xl border border-slate-700 bg-slate-900 p-6 sm:p-8"><p className="flex items-center gap-2 text-sm text-slate-400"><Wallet className="h-4 w-4"/>{tr('totalAssets')}</p><p className="mt-2 text-4xl font-bold">{loading?'—':formatUSDT(balance+holdingsValue)}</p><p className="mt-2 text-sm text-slate-400">{t('balance')}: {formatUSDT(balance)} · 持倉市值：{formatUSDT(holdingsValue)}</p><div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><button aria-label={tr('copyAddress')} onClick={copy} className="flex items-center gap-2 rounded-xl bg-slate-800 px-4 py-3 font-mono text-xs">{ADDRESS.slice(0,12)}...{ADDRESS.slice(-8)}{copied?<CheckCircle2 className="h-4 w-4 text-emerald-400"/>:<Copy className="h-4 w-4"/>}</button><p className="text-xs text-slate-500">測試 USDT 僅能由管理員後台發放</p></div></section>
  <section><h2 className="mb-4 text-xl font-bold">{t('holdings')}</h2><div className="grid gap-4 sm:grid-cols-2">{holdings.filter(h=>h.tokens>0).map(h=>{const asset=assetFor(h.assetId);return <article key={h.assetId} className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><p className="font-bold">{asset?.name??h.assetId}</p><p className="mt-2 text-sm text-slate-400">{h.tokens.toLocaleString()} {t('units')}</p><p className="mt-3 text-lg font-bold text-amber-300">{formatUSDT(h.tokens*(asset?.price??0))}</p></article>})}</div></section>
  <section><h2 className="mb-4 text-xl font-bold">{t('recent')}</h2><div className="overflow-x-auto rounded-2xl border border-slate-800"><table className="w-full min-w-[680px] text-left text-sm"><thead className="bg-slate-900 text-xs text-slate-500"><tr><th className="p-4">類型</th><th className="p-4">資產</th><th className="p-4">金額</th><th className="p-4">時間</th><th className="p-4">流水 ID</th></tr></thead><tbody>{transactions.map(tx=><tr key={tx.id} className="border-t border-slate-800"><td className="p-4">{tx.type}</td><td className="p-4">{tx.asset}</td><td className={`p-4 font-semibold ${tx.net>=0?'text-emerald-400':'text-red-400'}`}>{tx.net>=0?'+':''}{formatUSDT(tx.net)}</td><td className="p-4 text-slate-400">{tx.date}</td><td className="p-4 font-mono text-xs text-slate-500">{tx.hash.slice(0,12)}…</td></tr>)}</tbody></table></div></section>
 </div>
}
