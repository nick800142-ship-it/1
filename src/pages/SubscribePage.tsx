import { useState } from "react";
import { Clock3, MapPin } from "lucide-react";
import { formatUSDT, usePlatform, type Asset } from "@/platform";
import { Modal, Notice } from "@/components/Modal";

export function SubscribePage() {
  const { assets, balance, trade } = usePlatform();
  const [selected, setSelected] = useState<Asset | null>(null);
  const [quantity, setQuantity] = useState("100");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const placements = assets.filter((asset) => !asset.marketStartedAt);
  const active = (asset: Asset) => Date.now() < new Date(asset.endsAt).getTime() && asset.available > 0;
  const submit = async () => {
    if (!selected || !active(selected)) return;
    const result = await trade(selected.id, "private_buy", Number(quantity));
    setNotice({ text: result.message, ok: result.ok });
  };
  return <div className="flex flex-col gap-8">
    <header><p className="text-xs font-bold uppercase tracking-[.22em] text-amber-400">Primary offering</p><h1 className="mt-2 text-3xl font-bold">認購</h1><p className="mt-2 text-sm text-slate-400">所有尚未進入二級市場的標的物。</p></header>
    <div className="grid gap-5 sm:grid-cols-2">{placements.map((asset) => <article key={asset.id} className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900"><img src={asset.image} alt={asset.name} className="h-44 w-full object-cover"/><div className="p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="font-bold">{asset.name}</h2><p className="mt-1 flex items-center gap-1 text-xs text-slate-400"><MapPin className="size-3"/>{asset.location}</p></div><span className={`rounded-full px-3 py-1 text-xs font-bold ${active(asset) ? "bg-amber-400 text-slate-950" : "bg-slate-800 text-slate-400"}`}>{active(asset) ? "認購中" : asset.available <= 0 ? "已售罄" : "已結束"}</span></div><div className="mt-5 flex items-end justify-between"><div><p className="text-xs text-slate-500">認購單價</p><p className="text-xl font-bold">{formatUSDT(asset.price)}</p></div><p className="flex items-center gap-1 text-xs text-slate-400"><Clock3 className="size-3"/>{new Date(asset.endsAt).toLocaleDateString()}</p></div><button disabled={!active(asset)} onClick={() => { setSelected(asset); setNotice(null); }} className="mt-5 w-full rounded-xl bg-amber-400 py-3 font-bold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500">{active(asset) ? "立即認購" : "目前不可認購"}</button></div></article>)}</div>
    {!placements.length && <p className="rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center text-sm text-slate-400">目前沒有可顯示的非二級市場標的。</p>}
    <Modal open={!!selected} onClose={() => setSelected(null)} title={`認購 · ${selected?.name ?? ""}`}>{selected && <div className="flex flex-col gap-4"><div className="rounded-xl bg-slate-800 p-4 text-sm"><div className="flex justify-between"><span className="text-slate-400">可用餘額</span><b>{formatUSDT(balance)}</b></div><div className="mt-2 flex justify-between"><span className="text-slate-400">認購單價</span><b>{formatUSDT(selected.price)}</b></div></div><label className="text-sm">認購份額<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3"/></label><div className="flex justify-between text-sm"><span>認購總額</span><b>{formatUSDT((Number(quantity) || 0) * selected.price)}</b></div>{notice && <Notice message={notice.text} tone={notice.ok ? "success" : "error"}/>}<button onClick={() => void submit()} className="rounded-xl bg-amber-400 py-3 font-bold text-slate-950">確認認購</button></div>}</Modal>
  </div>;
}
