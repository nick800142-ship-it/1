import { useState } from 'react';
import { ArrowRight, MapPin, TrendingUp, TrendingDown, Filter } from 'lucide-react';

type Listing = {
  id: string;
  name: string;
  location: string;
  image: string;
  pricePerToken: number;
  change24h: number;
  available: number;
  total: number;
};

const LISTINGS: Listing[] = [
  {
    id: 'mel-southbank',
    name: '墨爾本 Southbank 河景公寓',
    location: 'Southbank, Melbourne',
    image: 'https://images.pexels.com/photos/1517586/pexels-photo-1517586.jpeg?auto=compress&cs=tinysrgb&w=800',
    pricePerToken: 1.02,
    change24h: 2.4,
    available: 8420,
    total: 25000,
  },
  {
    id: 'tokyo-shibuya',
    name: '東京澀谷商業大樓',
    location: 'Shibuya, Tokyo',
    image: 'https://images.pexels.com/photos/2506947/pexels-photo-2506947.jpeg?auto=compress&cs=tinysrgb&w=800',
    pricePerToken: 0.87,
    change24h: -1.1,
    available: 12300,
    total: 40000,
  },
  {
    id: 'singapore-marina',
    name: '新加坡 Marina Bay 景觀宅',
    location: 'Marina Bay, Singapore',
    image: 'https://images.pexels.com/photos/7746733/pexels-photo-7746733.jpeg?auto=compress&cs=tinysrgb&w=800',
    pricePerToken: 1.35,
    change24h: 3.8,
    available: 5600,
    total: 18000,
  },
  {
    id: 'london-canary',
    name: '倫敦 Canary Wharf 辦公室',
    location: 'Canary Wharf, London',
    image: 'https://images.pexels.com/photos/672532/pexels-photo-672532.jpeg?auto=compress&cs=tinysrgb&w=800',
    pricePerToken: 0.94,
    change24h: 0.6,
    available: 9800,
    total: 30000,
  },
];

export function MarketPage() {
  const [filter, setFilter] = useState<'all' | 'gainers' | 'losers'>('all');

  const filtered = LISTINGS.filter((l) => {
    if (filter === 'gainers') return l.change24h > 0;
    if (filter === 'losers') return l.change24h < 0;
    return true;
  });

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold tracking-tight text-white">二級市場</h1>
        <p className="mt-1 text-sm text-slate-400">買賣已代幣化的房地產份額，即時鏈上撮合</p>
      </section>

      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-slate-400" />
        {(['all', 'gainers', 'losers'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === f
                ? 'bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20'
                : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
            }`}
          >
            {f === 'all' ? '全部' : f === 'gainers' ? '上漲' : '下跌'}
          </button>
        ))}
      </div>

      {/* Listings grid */}
      <div className="grid gap-5 sm:grid-cols-2">
        {filtered.map((listing) => (
          <ListingCard key={listing.id} listing={listing} />
        ))}
      </div>
    </div>
  );
}

function ListingCard({ listing }: { listing: Listing }) {
  const up = listing.change24h >= 0;
  return (
    <article className="group overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-900/60 backdrop-blur-xl transition-all hover:border-slate-600/60 hover:shadow-xl hover:shadow-black/30">
      <div className="relative h-40 overflow-hidden">
        <div className="absolute inset-0 bg-cover bg-center transition-transform duration-500 group-hover:scale-105" style={{ backgroundImage: `url('${listing.image}')` }} />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/30 to-transparent" />
        <div className="absolute bottom-3 left-4 right-4">
          <h3 className="text-base font-bold text-white">{listing.name}</h3>
          <p className="flex items-center gap-1 text-xs text-slate-300">
            <MapPin className="h-3 w-3" />
            {listing.location}
          </p>
        </div>
      </div>

      <div className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400">每份價格</p>
            <p className="text-lg font-bold text-white">${listing.pricePerToken.toFixed(2)} USDC</p>
          </div>
          <div className={`flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold ${up ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
            {up ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {up ? '+' : ''}{listing.change24h.toFixed(1)}%
          </div>
        </div>

        {/* Availability bar */}
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[11px] text-slate-400">
            <span>可購份額</span>
            <span>{listing.available.toLocaleString()} / {listing.total.toLocaleString()}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600" style={{ width: `${(listing.available / listing.total) * 100}%` }} />
          </div>
        </div>

        <button className="group/btn mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800/60 py-2.5 text-sm font-medium text-slate-200 transition-all hover:bg-amber-500 hover:text-slate-900">
          買入
          <ArrowRight className="h-4 w-4 transition-transform group-hover/btn:translate-x-0.5" />
        </button>
      </div>
    </article>
  );
}
