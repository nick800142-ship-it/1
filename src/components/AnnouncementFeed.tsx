import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { interfaceText, useLanguage } from "@/platform";

type Announcement = {
  id: string;
  title: string;
  content: string;
  created_at: string;
};

function AnnouncementItem({ item }: { item: Announcement }) {
  return (
    <article className="border-t border-amber-500/20 pt-3 first:border-0 first:pt-0">
      <div className="flex flex-col justify-between gap-1 sm:flex-row">
        <h3 className="font-semibold text-amber-100">{item.title}</h3>
        <time className="shrink-0 text-xs text-amber-100/50">
          {new Date(item.created_at).toLocaleString()}
        </time>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-amber-100/75">
        {item.content}
      </p>
    </article>
  );
}

export function AnnouncementFeed({ fallback }: { fallback?: string }) {
  const { language } = useLanguage();
  const [items, setItems] = useState<Announcement[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase
      .from("platform_announcements")
      .select("id,title,content,created_at")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (active) setItems((data ?? []) as Announcement[]);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!items.length && !fallback) return null;
  const latest = items.slice(0, 2);

  return (
    <>
      <section
        aria-label={interfaceText(language, "platformAnnouncements")}
        className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Bell className="size-5 shrink-0 text-amber-300" />
            <h2 className="font-semibold text-amber-200">{interfaceText(language, "platformAnnouncements")}</h2>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-3">
          {latest.length ? (
            latest.map((item) => <AnnouncementItem key={item.id} item={item} />)
          ) : (
            <p className="text-sm leading-6 text-amber-100/75">{fallback}</p>
          )}
        </div>
        {items.length > 0 && (
          <div className="mt-4 border-t border-amber-500/20 pt-3">
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-full rounded-lg px-3 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/10"
            >
              {interfaceText(language, "viewMore")}
            </button>
          </div>
        )}
      </section>

      {showAll && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="announcement-history-title"
          className="fixed inset-0 z-50 flex max-w-full items-end justify-center overflow-x-hidden bg-slate-950/80 px-4 py-3 sm:items-center sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowAll(false);
          }}
        >
          <section className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <header className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-amber-300">{interfaceText(language, "platformAnnouncements")}</p>
                <h2
                  id="announcement-history-title"
                  className="mt-1 text-xl font-bold text-slate-100"
                >
                  {interfaceText(language, "announcementHistory")}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowAll(false)}
                aria-label={`${interfaceText(language, "close")} ${interfaceText(language, "announcementHistory")}`}
                className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800"
              >
                <X className="size-5" />
              </button>
            </header>
            <div className="mt-5 flex flex-col gap-4 overflow-y-auto pr-1">
              {items.map((item) => (
                <AnnouncementItem key={item.id} item={item} />
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
