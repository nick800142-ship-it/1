import { ArrowLeft, Building2, CircleDollarSign, ShieldCheck, Users } from 'lucide-react';
import { ASSETS, usePlatform } from '@/platform';

export function AdminPage({ onExit }: { onExit: () => void }) {
  const { balance, holdings, transactions } = usePlatform();
  const totalTokens = holdings.reduce((sum, holding) => sum + holding.tokens, 0);
  const cards = [
    { label: '上架資產', value: ASSETS.length.toLocaleString(), icon: Building2 },
    { label: '平台交易', value: transactions.length.toLocaleString(), icon: CircleDollarSign },
    { label: '持有代幣', value: totalTokens.toLocaleString(), icon: Users },
    { label: '可用資金', value: `${balance.toLocaleString()} USDT`, icon: ShieldCheck },
  ];

  return <div className="flex flex-col gap-8">
    <header className="flex flex-col gap-5 border-b border-slate-800 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="text-sm font-semibold text-amber-300">RWMT CONTROL DESK</p><h1 className="mt-2 text-3xl font-bold text-white">後台管理總覽</h1><p className="mt-2 text-sm text-slate-400">監看平台資產、交易與營運狀態。</p></div>
      <button type="button" onClick={onExit} className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"><ArrowLeft className="size-4"/>返回前台</button>
    </header>
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="平台統計">
      {cards.map(({label,value,icon:Icon})=><article key={label} className="rounded-2xl border border-slate-800 bg-slate-900 p-5"><Icon className="size-5 text-amber-300"/><p className="mt-5 text-sm text-slate-400">{label}</p><p className="mt-1 text-2xl font-bold text-white">{value}</p></article>)}
    </section>
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
      <header className="border-b border-slate-800 p-5"><h2 className="font-bold text-white">近期平台交易</h2></header>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="text-slate-500"><tr><th className="px-5 py-3 font-medium">資產</th><th className="px-5 py-3 font-medium">類型</th><th className="px-5 py-3 font-medium">金額</th><th className="px-5 py-3 font-medium">狀態</th><th className="px-5 py-3 font-medium">日期</th></tr></thead><tbody className="divide-y divide-slate-800">{transactions.slice(0,5).map(tx=><tr key={tx.id}><td className="px-5 py-4 font-medium text-slate-200">{tx.asset}</td><td className="px-5 py-4 uppercase text-slate-400">{tx.type}</td><td className="px-5 py-4 text-slate-200">{tx.gross.toLocaleString()} USDT</td><td className="px-5 py-4 text-emerald-400">已確認</td><td className="px-5 py-4 text-slate-500">{tx.date}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
