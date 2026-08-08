import { useState } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { HomePage } from '@/pages/HomePage';
import { MarketPage } from '@/pages/MarketPage';
import { WalletPage } from '@/pages/WalletPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { LanguageProvider, PlatformProvider } from '@/platform';
import type { PageKey } from '@/nav';

function App(){const[page,setPage]=useState<PageKey>('home');return <LanguageProvider><PlatformProvider><div className="min-h-screen bg-slate-950 text-slate-100 antialiased"><Sidebar current={page} onNavigate={setPage}/><main className="relative mx-auto max-w-6xl px-4 py-8 pb-24 sm:px-6 lg:ml-60 lg:px-10 lg:py-10">{page==='home'&&<HomePage/>}{page==='market'&&<MarketPage/>}{page==='wallet'&&<WalletPage/>}{page==='settings'&&<SettingsPage/>}</main></div></PlatformProvider></LanguageProvider>}
export default App;
