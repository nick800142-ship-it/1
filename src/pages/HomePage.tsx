import { useState } from 'react';
import {
  Wallet,
  TrendingUp,
  ShieldCheck,
  ArrowRight,
  MapPin,
  CheckCircle2,
  Sparkles,
  Building2,
  Users,
} from 'lucide-react';

type Property = {
  id: string;
  name: string;
  location: string;
  image: string;
  valuation: string;
  apy: string;
  tokenPrice: string;
  funded: number;
  holders: number;
  verified: boolean;
};

const MORE_PROPERTIES: Property[] = [
  {
    id: 'tokyo-shibuya',
    name: '東京澀谷商業大樓',
    location: 'Shibuya, Tokyo, Japan',
    image: 'https://images.pexels.com/photos/31298878/pexels-photo-31298878.jpeg?auto=compress&cs=tinysrgb&w=1200',
    valuation: '$3,200,000 USDC',
    apy: '7.2%',
    tokenPrice: '$0.80 USDC',
    funded: 68,
    holders: 1240,
    verified: true,
  },
  {
    id: 'singapore-marina',
    name: '新加坡 Marina Bay 景觀宅',
    location: 'Marina Bay, Singapore',
    image: 'https://images.pexels.com/photos/17939743/pexels-photo-17939743.jpeg?auto=compress&cs=tinysrgb&w=1200',
    valuation: '$4,800,000 USDC',
    apy: '9.1%',
    tokenPrice: '$1.20 USDC',
    funded: 82,
    holders: 2180,
    verified: true,
  },
  {
    id: 'london-canary',
    name: '倫敦 Canary Wharf 辦公室',
    location: 'Canary Wharf, London, UK',
    image: 'https://images.pexels.com/photos/10899667/pexels-photo-10899667.jpeg?auto=compress&cs=tinysrgb&w=1200',
    valuation: '$2,900,000 USDC',
    apy: '6.5%',
    tokenPrice: '$0.58 USDC',
    funded: 45,
    holders: 860,
    verified: true,
  },
];

export function HomePage() {
  const [subscribed, setSubscribed] = useState(false);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold tracking-tight text-white">精選項目</h1>
        <p className="mt-1 text-sm text-slate-400">經過鏈上驗證的優質房地產代幣化資產</p>
      </section>

      {/* Property Card */}
      <article className="overflow-hidden rounded-3xl border border-slate-700/50 bg-slate-900/60 shadow-2xl shadow-black/40 backdrop-blur-xl">
        <div className="relative h-72 w-full overflow-hidden sm:h-80">
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{
              backgroundImage:
                "url('https://images.pexels.com/photos/1517586/pexels-photo-1517586.jpeg?auto=compress&cs=tinysrgb&w=1600')",
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent" />
          <div className="absolute bottom-5 left-6 right-6">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/90 px-3 py-1 text-xs font-semibold text-slate-900">
              <Sparkles className="h-3.5 w-3.5" />
              精選項目
            </span>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              墨爾本 Southbank 河景豪華公寓
            </h2>
            <p className="mt-1.5 flex items-center gap-1.5 text-sm text-slate-300">
              <MapPin className="h-4 w-4" />
              Southbank, Melbourne, Australia
            </p>
          </div>
        </div>

        <div className="p-6 sm:p-8">
          <p className="text-sm leading-relaxed text-slate-300">
            位於墨爾本 Southbank 核心地段的高層河景公寓，俯瞰雅拉河與皇家植物園，鄰近 Crown 賭場與中央商務區。透過鏈上代幣化，投資人得以低門檻參與澳洲一線城市優質房地產，享受穩定租金收益與資產增值。
          </p>

          <div className="mt-7 grid gap-4 sm:grid-cols-3">
            <DataTag icon={<Wallet className="h-5 w-5" />} label="總資產估值" value="$2,500,000 USDC" accent="amber" />
            <DataTag icon={<TrendingUp className="h-5 w-5" />} label="預計年化收益率 (APY)" value="8.8%" accent="emerald" />
            <DataTag icon={<ShieldCheck className="h-5 w-5" />} label="SPV 資產儲備證明" value="已通過 Chainlink PoR 驗證" accent="sky" />
          </div>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
            <p className="text-xs text-slate-400">最低認購門檻 1,000 USDC ・ 即時鏈上結算</p>
            <button
              onClick={() => setSubscribed(true)}
              className="group inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 via-amber-500 to-amber-600 px-7 py-3.5 text-base font-semibold text-slate-900 shadow-lg shadow-amber-500/30 transition-all hover:shadow-xl hover:shadow-amber-500/40 hover:brightness-110 active:scale-[0.98] sm:w-auto"
            >
              {subscribed ? (
                <>
                  <CheckCircle2 className="h-5 w-5" />
                  認購請求已送出
                </>
              ) : (
                <>
                  立即以 USDC 認購
                  <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-0.5" />
                </>
              )}
            </button>
          </div>
        </div>
      </article>

      {/* Stats overview */}
      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard label="平台總資產估值" value="$48.2M USDC" icon={<Building2 className="h-5 w-5" />} />
        <StatCard label="已代幣化項目" value="17" icon={<Sparkles className="h-5 w-5" />} />
        <StatCard label="平均 APY" value="7.6%" icon={<TrendingUp className="h-5 w-5" />} />
      </section>

      {/* More projects */}
      <section>
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-white">更多項目</h2>
            <p className="mt-1 text-sm text-slate-400">探索其他代幣化房地產機會</p>
          </div>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {MORE_PROPERTIES.map((prop) => (
            <PropertyMiniCard key={prop.id} property={prop} />
          ))}
        </div>
      </section>
    </div>
  );
}

function DataTag({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: 'amber' | 'emerald' | 'sky';
}) {
  const accents: Record<string, string> = {
    amber: 'from-amber-500/15 to-amber-500/5 text-amber-300 ring-amber-500/20',
    emerald: 'from-emerald-500/15 to-emerald-500/5 text-emerald-300 ring-emerald-500/20',
    sky: 'from-sky-500/15 to-sky-500/5 text-sky-300 ring-sky-500/20',
  };
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${accents[accent]} p-4 ring-1 ring-inset backdrop-blur-sm transition-transform hover:-translate-y-0.5`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900/60 ring-1 ring-white/10">{icon}</span>
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
      </div>
      <p className="text-base font-bold tracking-tight text-white">{value}</p>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-700/50 bg-slate-900/40 p-5 backdrop-blur-sm">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800/60 text-amber-300">{icon}</div>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-bold tracking-tight text-white">{value}</p>
    </div>
  );
}

function PropertyMiniCard({ property }: { property: Property }) {
  return (
    <article className="group overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-900/60 backdrop-blur-xl transition-all hover:border-slate-600/60 hover:shadow-xl hover:shadow-black/30">
      <div className="relative h-44 overflow-hidden">
        <div
          className="absolute inset-0 bg-cover bg-center transition-transform duration-500 group-hover:scale-105"
          style={{ backgroundImage: `url('${property.image}')` }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/30 to-transparent" />
        {property.verified && (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-emerald-500/90 px-2.5 py-1 text-[11px] font-semibold text-slate-900">
            <ShieldCheck className="h-3 w-3" />
            PoR 已驗證
          </span>
        )}
        <div className="absolute bottom-3 left-4 right-4">
          <h3 className="text-base font-bold text-white">{property.name}</h3>
          <p className="flex items-center gap-1 text-xs text-slate-300">
            <MapPin className="h-3 w-3" />
            {property.location}
          </p>
        </div>
      </div>

      <div className="p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] text-slate-400">總估值</p>
            <p className="text-sm font-bold text-white">{property.valuation}</p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">預計 APY</p>
            <p className="text-sm font-bold text-emerald-400">{property.apy}</p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
          <span>每份 {property.tokenPrice}</span>
          <span className="flex items-center gap-1">
            <Users className="h-3 w-3" />
            {property.holders.toLocaleString()} 人
          </span>
        </div>

        <div className="mt-3">
          <div className="mb-1 flex justify-between text-[11px] text-slate-400">
            <span>已完成</span>
            <span>{property.funded}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600 transition-all"
              style={{ width: `${property.funded}%` }}
            />
          </div>
        </div>

        <button className="group/btn mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800/60 py-2.5 text-sm font-medium text-slate-200 transition-all hover:bg-amber-500 hover:text-slate-900">
          了解詳情
          <ArrowRight className="h-4 w-4 transition-transform group-hover/btn:translate-x-0.5" />
        </button>
      </div>
    </article>
  );
}
