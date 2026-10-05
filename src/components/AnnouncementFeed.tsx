import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Modal } from "@/components/Modal";
import { supabase } from "@/lib/supabase";
import { playNotificationSound, showSystemNotification } from "@/lib/pushNotifications";
import { interfaceText, useLanguage } from "@/platform";

type AnnouncementTranslation = { title?: string; content?: string };
type Announcement = {
  id: string;
  title: string;
  content: string;
  translations?: Record<string, AnnouncementTranslation>;
  created_at: string;
};

function AnnouncementItem({ item, language }: { item: Announcement; language: string }) {
  const localized = item.translations?.[language];
  const traditionalChinese = item.translations?.["zh-TW"];
  const valid = (value?: string) => Boolean(value?.trim() && !value.includes("�"));
  const title = valid(localized?.title)
    ? localized!.title!.trim()
    : valid(traditionalChinese?.title)
      ? traditionalChinese!.title!.trim()
      : item.title;
  const content = valid(localized?.content)
    ? localized!.content!.trim()
    : valid(traditionalChinese?.content)
      ? traditionalChinese!.content!.trim()
      : item.content;
  return (
    <article className="border-t border-amber-500/20 pt-3 first:border-0 first:pt-0">
      <div className="flex flex-col justify-between gap-1 sm:flex-row">
        <h3 className="font-semibold text-amber-100">{title}</h3>
        <time className="shrink-0 text-xs text-amber-100/50">
          {new Date(item.created_at).toLocaleString(language)}
        </time>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-amber-100/75">
        {content}
      </p>
    </article>
  );
}

export function AnnouncementFeed({ fallback }: { fallback?: string }) {
  const { language } = useLanguage();
  const [items, setItems] = useState<Announcement[]>([]);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [readStorageKey, setReadStorageKey] = useState("rwmt-read-announcements:session");
  const [isOpen, setIsOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      const key = `rwmt-read-announcements:${data.user?.id ?? "session"}`;
      setReadStorageKey(key);
      try {
        const stored = JSON.parse(sessionStorage.getItem(key) ?? "[]");
        setReadIds(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
      } catch {
        setReadIds([]);
      }
    });
    void supabase
      .from("platform_announcements")
      .select("id,title,content,translations,created_at")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (active) setItems((data ?? []) as Announcement[]);
      });
    const channel = supabase
      .channel("public-announcement-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "platform_announcements" },
        (payload) => {
          const announcement = payload.new as Announcement & { is_active?: boolean };
          if (announcement.is_active === false) return;
          setItems((current) => [announcement, ...current.filter((item) => item.id !== announcement.id)]);
          sessionStorage.setItem("last-notified-announcement", announcement.id);
          showSystemNotification(announcement.title, announcement.content);
          playNotificationSound();
        },
      )
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, []);

  if (!items.length && !fallback) return null;
  const latest = items.slice(0, 1);
  const unreadCount = items.filter((item) => !readIds.includes(item.id)).length;
  const announcementLabel = interfaceText(language, "platformAnnouncements");
  const unreadLabel = language.startsWith("zh") ? `${unreadCount} 則未讀` : `${unreadCount} unread`;

  return (
    <>
      <section aria-label={announcementLabel} className="self-start w-fit">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls="platform-announcement-content"
          aria-label={unreadCount > 0 ? `${announcementLabel}, ${unreadLabel}` : announcementLabel}
          onClick={() => {
            if (!isOpen && items.length > 0) {
              const nextReadIds = Array.from(new Set([...readIds, ...items.map((item) => item.id)]));
              setReadIds(nextReadIds);
              try {
                sessionStorage.setItem(readStorageKey, JSON.stringify(nextReadIds));
              } catch {
                // Keep the current view usable when browser storage is unavailable.
              }
            }
            setShowAll(false);
            setIsOpen(true);
          }}
          className="relative inline-flex size-10 items-center justify-center rounded-full text-sky-300 transition hover:bg-sky-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          <Bell aria-hidden="true" className="size-6" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </section>
      <Modal
        open={isOpen}
        onClose={() => setIsOpen(false)}
        title={announcementLabel}
        closeLabel={interfaceText(language, "close")}
        centered
      >
        <div id="platform-announcement-content" className="flex flex-col gap-4">
          {(showAll ? items : latest).length ? (
            (showAll ? items : latest).map((item) => (
              <AnnouncementItem key={item.id} item={item} language={language} />
            ))
          ) : (
            <p className="text-sm leading-6 text-slate-300">{fallback}</p>
          )}
        </div>
        {items.length > 1 && (
          <div className="mt-4 border-t border-slate-700 pt-3">
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((expanded) => !expanded)}
              className="w-full rounded-xl bg-sky-300/10 px-3 py-3 text-sm font-semibold text-amber-200 transition hover:bg-sky-300/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
            >
              {showAll
                ? language.startsWith("zh") ? "收合" : "Show less"
                : interfaceText(language, "viewMore")}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
