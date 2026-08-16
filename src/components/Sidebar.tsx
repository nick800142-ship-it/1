import type { User } from "@supabase/supabase-js";
import { NAV_ITEMS } from "@/nav";
import { useLanguage } from "@/platform";
import type { PageKey } from "@/nav";

type Props = {
  current: PageKey;
  onNavigate: (p: PageKey) => void;
  user: User;
  isAgent?: boolean;
};
export function Sidebar({ current, onNavigate, user, isAgent }: Props) {
  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-slate-800 bg-slate-950/95 backdrop-blur lg:flex">
        <Inner
          current={current}
          onNavigate={onNavigate}
          user={user}
          isAgent={isAgent}
        />
      </aside>
      <nav
        aria-label="Mobile navigation"
        className="mobile-bottom-nav fixed inset-x-0 bottom-0 z-50 flex min-h-20 border-t border-slate-800 bg-slate-950/95 px-2 pt-2 backdrop-blur lg:hidden"
      >
        <Items
          current={current}
          onNavigate={onNavigate}
          mobile
          isAgent={isAgent}
        />
      </nav>
    </>
  );
}
function Items({
  current,
  onNavigate,
  mobile = false,
  isAgent = false,
}: {
  current: PageKey;
  onNavigate: (p: PageKey) => void;
  mobile?: boolean;
  isAgent?: boolean;
}) {
  const { t, tr } = useLanguage();
  return (
    <>
      {NAV_ITEMS.filter((item) => item.key !== "agent" || isAgent).map(
        (item) => {
          const Icon = item.icon;
          const active = current === item.key;
          return (
            <button
              key={item.key}
              onClick={() => onNavigate(item.key)}
              aria-current={active ? "page" : undefined}
              className={`${mobile ? "flex-1 flex-col justify-center text-[11px]" : "w-full"} flex items-center gap-2 rounded-xl px-3 py-2.5 font-medium transition ${active ? "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20" : "text-slate-400 hover:bg-slate-900 hover:text-white"}`}
            >
              <Icon className="size-5" />
              {item.key === "agent"
                ? tr("agentCenter")
                : item.key === "subscribe"
                  ? tr("subscribeTitle")
                  : t(item.key)}
            </button>
          );
        },
      )}
    </>
  );
}
function Inner({ user, ...props }: Props) {
  const name = user.user_metadata?.full_name || user.email || "Google User";
  return (
    <>
      <div className="flex items-center gap-3 px-6 py-6">
        <div className="flex size-10 items-center justify-center rounded-xl bg-amber-400 font-black text-slate-950">
          R
        </div>
        <div>
          <p className="font-bold text-white">RWMT</p>
          <p className="text-xs text-slate-500">Tokenized property</p>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3">
        <Items {...props} />
      </nav>
      <div className="border-t border-slate-800 p-4">
        <div className="min-w-0 rounded-xl bg-slate-900 p-3">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-slate-500">{user.email}</p>
        </div>
      </div>
    </>
  );
}
