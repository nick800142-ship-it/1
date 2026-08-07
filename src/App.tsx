import { useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { HomePage } from '@/pages/HomePage';
import { MarketPage } from '@/pages/MarketPage';
import { WalletPage } from '@/pages/WalletPage';
import { SettingsPage } from '@/pages/SettingsPage';
import type { PageKey } from '@/nav';

function App() {
  const [page, setPage] = useState<PageKey>('home');

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100 antialiased">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 -left-40 h-96 w-96 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="absolute top-1/3 -right-40 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <Sidebar current={page} onNavigate={setPage} />

      {/* Main content */}
      <main className="relative mx-auto max-w-5xl px-6 py-10 pb-24 lg:ml-60 lg:px-12 lg:py-12">
        {page === 'home' && <HomePage />}
        {page === 'market' && <MarketPage />}
        {page === 'wallet' && <WalletPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

export default App;
