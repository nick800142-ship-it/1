import { useState } from 'react';
import { Wallet, ArrowDownLeft, ArrowUpRight, Copy, CheckCircle2, Coins } from 'lucide-react';

type Holding = {
  name: string;
  tokens: number;
  value: number;
  apy: number;
};

type Tx = {
  id: string;
  type: 'buy' | 'sell' | 'dividend' | 'deposit';
  asset: string;
  amount: number;
  date: string;
};

const HOLDINGS: Holding[] = [
  { name: '墨爾本 Southbank 河景公寓', tokens: 500, value: 510, apy: 8.8 },
  { name: '東京澀谷商業大樓', tokens: 1200, value: 1044, apy: 7.2 },
  { name: '新加坡 Marina Bay 景觀宅', tokens: 300, value: 405, apy: 9.1 },
];

const TRANSACTIONS: Tx[] = [
  { id: 'tx1', type: 'buy', asset: '墨爾本 Southbank', amount: -510, date: '2026-08-05' },
  { id: 'tx2', type: 'dividend', asset: '東京澀谷商業大樓', amount: 86.4, date: '2026-08-01' },
  { id: 'tx3', type: 'deposit', asset: 'USDC', amount: 5000, date: '2026-07-28' },
  { id: 'tx4', type: 'buy', asset: '新加坡 Marina Bay', amount: -405, date: '2026-07-20' },
  { id: 'tx5', type: 'sell', asset: '倫敦 Canary Wharf', amount: 282, date: '2026-07-15' },
];

const WALLET_ADDRESS = '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';

export function WalletPage() {
  const [copied, setCopied] = useState(false);
  const totalValue = HOLDINGS.reduce((sum, h) => sum + h.value, 0) + 3268.6;
  const holdingsValue = HOLDINGS.reduce((sum, h) => sum + h.value, 0);

  const copyAddress = () => {
    navigator.clipboard?.writeText(WALLET_ADDRESS);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold tracking-tight text-white">錢包</h1>
        <p className="mt-1 text-sm text-slate-400">管理你的 USDC 餘額與鏈上資產</p>
      </section>

      {/* Balance card */}
      <section className="overflow-hidden rounded-3xl border border-slate-700/50 bg-gradient-to-br from-slate-900/80 to-slate-800/40 p-6 backdrop-blur-xl sm:p-8">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Wallet className="h-4 w-4" />
          總資產價值
        </div>
        <p className="mt-2 text-4xl font-bold tracking-tight text-white">${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</p>

        <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 rounded-lg bg-slate-800/60 px-3 py-2">
            <span className="font-mono text-xs text-slate-300">{WALLET_ADDRESS.slice(0, 10)}...{WALLET_ADDRESS.slice(-8)}</span>
            <button onClick={copyAddress} className="text-slate-400 transition-colors hover:text-amber-300">
              {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <div className="flex gap-3">
            <button className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-semibold text-slate-900 transition-all hover:brightness-110 active:scale-[0.98]">
              <ArrowDownLeft className="h-4 w-4" />
              充值
            </button>
            <button className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/60 px-5 py-2.5 text-sm font-semibold text-slate-200 transition-all hover:bg-slate-700/60 active:scale-[0.98]">
              <ArrowUpRight className="h-4 w-4" />
              提領
            </button>
          </div>
        </div>
      </section>

      {/* Holdings */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-white">持倉資產</h2>
        <div className="overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-900/40 backdrop-blur-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-700/50 bg-slate-800/30 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">資產</th>
                <th className="px-4 py-3 text-right font-medium">份額</th>
                <th className="hidden px-4 py-3 text-right font-medium sm:table-cell">價值 (USDC)</th>
                <th className="px-4 py-3 text-right font-medium">APY</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {HOLDINGS.map((h) => (
                <tr key={h.name} className="transition-colors hover:bg-slate-800/30">
                  <td className="px-4 py-3 font-medium text-white">{h.name}</td>
                  <td className="px-4 py-3 text-right text-slate-300">{h.tokens.toLocaleString()}</td>
                  <td className="hidden px-4 py-3 text-right text-slate-300 sm:table-cell">{h.value.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right font-semibold text-emerald-400">{h.apy}%</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-slate-700/50 bg-slate-800/30 text-xs text-slate-400">
              <tr>
                <td className="px-4 py-2.5 font-medium text-slate-300">持倉總計</td>
                <td className="px-4 py-2.5 text-right text-slate-300">{HOLDINGS.reduce((s, h) => s + h.tokens, 0).toLocaleString()}</td>
                <td className="hidden px-4 py-2.5 text-right text-slate-300 sm:table-cell">{holdingsValue.toLocaleString()}</td>
                <td className="px-4 py-2.5" />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Transactions */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-white">近期交易</h2>
        <div className="space-y-2">
          {TRANSACTIONS.map((tx) => (
            <TxRow key={tx.id} tx={tx} />
          ))}
        </div>
      </section>
    </div>
  );
}

function TxRow({ tx }: { tx: Tx }) {
  const inflow = tx.amount > 0;
  const labels: Record<Tx['type'], string> = {
    buy: '買入',
    sell: '賣出',
    dividend: '收益分配',
    deposit: '充值',
  };
  const icons: Record<Tx['type'], React.ReactNode> = {
    buy: <ArrowUpRight className="h-4 w-4 text-red-400" />,
    sell: <ArrowDownLeft className="h-4 w-4 text-emerald-400" />,
    dividend: <Coins className="h-4 w-4 text-amber-400" />,
    deposit: <ArrowDownLeft className="h-4 w-4 text-emerald-400" />,
  };

  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-800/50 bg-slate-900/40 px-4 py-3 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-800/60">{icons[tx.type]}</span>
        <div>
          <p className="text-sm font-medium text-white">{labels[tx.type]}</p>
          <p className="text-xs text-slate-400">{tx.asset} ・ {tx.date}</p>
        </div>
      </div>
      <p className={`text-sm font-semibold ${inflow ? 'text-emerald-400' : 'text-red-400'}`}>
        {inflow ? '+' : ''}{tx.amount.toLocaleString()} USDC
      </p>
    </div>
  );
}
