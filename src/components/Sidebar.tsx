import { NAV_ITEMS } from '@/nav';
import type { PageKey } from '@/nav';

type SidebarProps = {
  current: PageKey;
  onNavigate: (page: PageKey) => void;
};

export function Sidebar({ current, onNavigate }: SidebarProps) {
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed left-0 top-0 z-30 hidden h-full w-60 flex-col border-r border-slate-800/60 bg-slate-950/80 backdrop-blur-xl lg:flex">
        <SidebarInner current={current} onNavigate={onNavigate} />
      </aside>

      {/* Mobile bottom nav */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around border-t border-slate-800/60 bg-slate-950/90 px-2 py-2 backdrop-blur-xl lg:hidden">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = current === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              className={`flex flex-1 flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors ${
                active ? 'text-amber-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className={`h-5 w-5 ${active ? 'text-amber-400' : ''}`} />
              {item.label}
            </button>
          );
        })}
      </nav>
    </>
  );
}

function SidebarInner({ current, onNavigate }: SidebarProps) {
  return (
    <>
      <div className="flex items-center gap-3 px-6 py-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-lg shadow-amber-500/20">
          <span className="text-lg font-bold text-slate-900">R</span>
        </div>
        <div>
          <p className="text-sm font-semibold tracking-tight text-white">RWA 平台</p>
          <p className="text-[11px] text-slate-400">鏈上房地產投資</p>
        </div>
      </div>

      <nav className="mt-2 flex-1 space-y-1 px-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = current === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
                active
                  ? 'bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
              }`}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-slate-800/60 p-4">
        <div className="flex items-center gap-3 rounded-xl bg-slate-900/60 p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-sm font-bold text-slate-900">
            A
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">投資人 A</p>
            <p className="truncate text-[11px] text-slate-400">0x1a2b...4f5e</p>
          </div>
        </div>
      </div>
    </>
  );
}
