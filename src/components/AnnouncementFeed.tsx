import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Bell } from "lucide-react";
import { Modal } from "@/components/Modal";
import { supabase } from "@/lib/supabase";
import { playNotificationSound, showSystemNotification } from "@/lib/pushNotifications";
import { interfaceText, useLanguage } from "@/platform";
import { resolveAnnouncementDestination } from "@/lib/announcementRouting";
import type { AnnouncementAsset } from "@/lib/announcementRouting";

type AnnouncementTranslation = { title?: string; content?: string };
type Announcement = {
  id: string;
  title: string;
  content: string;
  translations?: Record<string, AnnouncementTranslation>;
  created_at: string;
};



function getLocalizedAnnouncement(item: Announcement, language: string) {
  const localized = item.translations?.[language];
  const traditionalChinese = item.translations?.["zh-TW"];
  const valid = (value?: string) => Boolean(value?.trim() && !value.includes("資料"));
  const sourceText = language === "zh-TW" ? { title: item.title, content: item.content } : null;
  return {
    title: sourceText?.title ?? (valid(localized?.title)
      ? localized!.title!
      : valid(traditionalChinese?.title)
        ? traditionalChinese!.title!
        : item.title),
    content: sourceText?.content ?? (valid(localized?.content)
      ? localized!.content!
      : valid(traditionalChinese?.content)
        ? traditionalChinese!.content!
        : item.content),
  };
}

const announcementCopy: Record<string, { newPromotion: string; goToAgent: string }> = {
  "zh-TW": { newPromotion: "新推廣制度公告", goToAgent: "前往代理中心設定" },
  "zh-CN": { newPromotion: "新推广制度公告", goToAgent: "前往代理中心设置" },
  en: { newPromotion: "New promotion system", goToAgent: "Go to agent center settings" },
  ja: { newPromotion: "新しい紹介制度のお知らせ", goToAgent: "エージェントセンターの設定へ" },
  ko: { newPromotion: "새 추천 제도 공지", goToAgent: "에이전트 센터 설정으로 이동" },
  th: { newPromotion: "ประกาศระบบแนะนำใหม่", goToAgent: "ไปที่การตั้งค่าศูนย์ตัวแทน" },
  vi: { newPromotion: "Thông báo hệ thống giới thiệu mới", goToAgent: "Đến cài đặt trung tâm đại lý" },
  id: { newPromotion: "Pengumuman sistem promosi baru", goToAgent: "Buka pengaturan pusat agen" },
  ms: { newPromotion: "Pengumuman sistem promosi baharu", goToAgent: "Pergi ke tetapan pusat ejen" },
  es: { newPromotion: "Anuncio del nuevo sistema de promoción", goToAgent: "Ir a la configuración del centro de agentes" },
  fr: { newPromotion: "Annonce du nouveau système de parrainage", goToAgent: "Ouvrir les réglages du centre des agents" },
  de: { newPromotion: "Ankündigung des neuen Empfehlungssystems", goToAgent: "Zu den Einstellungen des Agentencenters" },
  pt: { newPromotion: "Anúncio do novo sistema de indicação", goToAgent: "Abrir definições do centro de agentes" },
  ru: { newPromotion: "Объявление о новой реферальной системе", goToAgent: "Перейти к настройкам агентского центра" },
  ar: { newPromotion: "إعلان نظام الإحالة الجديد", goToAgent: "الانتقال إلى إعدادات مركز الوكلاء" },
  hi: { newPromotion: "नई रेफ़रल प्रणाली की घोषणा", goToAgent: "एजेंट केंद्र की सेटिंग खोलें" },
};

function AnnouncementItem({ item, language }: { item: Announcement; language: string }) {
  const { title, content } = getLocalizedAnnouncement(item, language);
  return (
    <article>
      <div className="flex flex-col justify-between gap-1 sm:flex-row">
        <h3 className="font-semibold text-amber-100">{title}</h3>
        <time className="shrink-0 text-xs text-amber-100/50">
          {new Date(item.created_at).toLocaleString(language)}
        </time>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-amber-100/75">
        {content}
      </p>
    </article>
  );
}

export function AnnouncementFeed({ fallback, autoOpenLatest = false }: { fallback?: string; autoOpenLatest?: boolean }) {
  const { language } = useLanguage();
  const copy = announcementCopy[language] ?? announcementCopy.en;
  const assets: AnnouncementAsset[] = [];
  const [items, setItems] = useState<Announcement[]>([]);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [readStorageKey, setReadStorageKey] = useState("rwmt-read-announcements:session");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedAnnouncementId, setSelectedAnnouncementId] = useState<string | null>(null);
  const [forcedAnnouncementId, setForcedAnnouncementId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(async ({ data }) => {
      if (!active) return;
      const userId = data.user?.id;
      const key = `rwmt-read-announcements:${userId ?? "session"}`;
      setReadStorageKey(key);
      try {
        const stored = JSON.parse(sessionStorage.getItem(key) ?? "[]");
        setReadIds(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
      } catch {
        setReadIds([]);
      }
      const [announcementsResult, readsResult] = await Promise.all([
        supabase
          .from("platform_announcements")
          .select("id,title,content,translations,created_at")
          .eq("is_active", true)
          .order("created_at", { ascending: false }),
        userId
          ? supabase.from("user_announcement_reads").select("announcement_id").eq("user_id", userId)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (!active) return;
      const announcements = (announcementsResult.data ?? []) as Announcement[];
      setItems(announcements);
      const persistedReadIds = (readsResult.data ?? [])
        .map((row) => row.announcement_id)
        .filter((id): id is string => typeof id === "string");
      setReadIds((current) => [...new Set([...current, ...persistedReadIds])]);
      if (autoOpenLatest && announcements[0] && !persistedReadIds.includes(announcements[0].id)) {
        setForcedAnnouncementId(announcements[0].id);
      }
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
          const translated = getLocalizedAnnouncement(announcement, language);
          showSystemNotification(translated.title, translated.content);
          playNotificationSound();
        },
      )
      .subscribe();
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [language]);

  useEffect(() => {
    if (!forcedAnnouncementId) return;
    setSelectedAnnouncementId(forcedAnnouncementId);
    setIsOpen(true);
  }, [forcedAnnouncementId]);

  if (!items.length && !fallback) return null;
  const selectedAnnouncement = items.find((item) => item.id === selectedAnnouncementId);
  const unreadCount = items.filter((item) => !readIds.includes(item.id)).length;
  const announcementLabel = interfaceText(language, "platformAnnouncements");
  const unreadLabel = {
    "zh-TW": `${unreadCount} 則未讀`, "zh-CN": `${unreadCount} 資料資料資料未读`, en: `${unreadCount} unread`,
    ja: `${unreadCount}件未読`, ko: `${unreadCount}개 읽지 않음`, th: `ยังไม่อ่าน ${unreadCount} รายการ`,
    vi: `${unreadCount} chưa đọc`, id: `${unreadCount} belum dibaca`, ms: `${unreadCount} belum dibaca`,
    es: `${unreadCount} sin leer`, fr: `${unreadCount} non lu`, de: `${unreadCount} ungelesen`,
    pt: `${unreadCount} não lidas`, ru: `Непрочитано: ${unreadCount}`, ar: `${unreadCount} غير مقروء`, hi: `${unreadCount} अपठित`,
  }[language];
  const markAnnouncementRead = (item: Announcement) => {
    if (readIds.includes(item.id)) return;
    const nextReadIds = [...readIds, item.id];
    setReadIds(nextReadIds);
    void supabase.auth.getUser().then(({ data }) => {
      if (data.user?.id) {
        void supabase.from("user_announcement_reads").upsert({
          user_id: data.user.id,
          announcement_id: item.id,
        }, { onConflict: "user_id,announcement_id" });
      }
    });
    try {
      sessionStorage.setItem(readStorageKey, JSON.stringify(nextReadIds));
    } catch {
      // Keep the current view usable when browser storage is unavailable.
    }
  };
  const markAllAnnouncementsRead = () => {
    if (!items.length) return;
    const nextReadIds = [...new Set([...readIds, ...items.map((item) => item.id)])];
    setReadIds(nextReadIds);
    try {
      sessionStorage.setItem(readStorageKey, JSON.stringify(nextReadIds));
    } catch {
      // Keep the current view usable when browser storage is unavailable.
    }
    void supabase.auth.getUser().then(({ data }) => {
      if (!data.user?.id) return;
      void supabase.from("user_announcement_reads").upsert(
        items.map((item) => ({ user_id: data.user.id, announcement_id: item.id })),
        { onConflict: "user_id,announcement_id" },
      );
    });
  };
  const openAnnouncement = (item: Announcement) => {
    setSelectedAnnouncementId(item.id);
    markAnnouncementRead(item);
  };
  const followAnnouncement = (item: Announcement) => {
    const destination = resolveAnnouncementDestination(item, assets);
    if (!destination) {
      openAnnouncement(item);
      return;
    }
    markAnnouncementRead(item);
    setSelectedAnnouncementId(null);
    setIsOpen(false);
    window.dispatchEvent(new CustomEvent("navigate-to-announcement-target", { detail: destination }));
  };

  return (
    <>
      <section aria-label={announcementLabel} className="self-start w-fit">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls="platform-announcement-content"
          aria-label={unreadCount > 0 ? `${announcementLabel}, ${unreadLabel}` : announcementLabel}
          onClick={() => {
            markAllAnnouncementsRead();
            setSelectedAnnouncementId(null);
            setIsOpen(true);
          }}
          className="relative inline-flex size-10 items-center justify-center rounded-full text-sky-300 transition hover:bg-sky-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
        >
          <Bell aria-hidden="true" className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-3.5 items-center justify-center rounded-sm bg-red-600 px-1 text-[8px] font-bold leading-none text-white">
              NEW
            </span>
          )}
        </button>
      </section>
      <Modal
        open={isOpen}
        onClose={() => {
          setIsOpen(false);
          setSelectedAnnouncementId(null);
        }}
        title={forcedAnnouncementId ? copy.newPromotion : announcementLabel}
        closeLabel={forcedAnnouncementId ? copy.goToAgent : interfaceText(language, "close")}
        centered
        dismissible={!forcedAnnouncementId}
      >
        <div id="platform-announcement-content" className="max-h-[68dvh] overflow-y-auto pr-1">
          {selectedAnnouncement ? (
            <div className="flex flex-col gap-4">
              <button
                type="button"
                onClick={() => setSelectedAnnouncementId(null)}
                className="inline-flex w-fit items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-300/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
              >
                <ArrowLeft aria-hidden="true" className="size-4" />
                {interfaceText(language, "announcementHistory")}
              </button>
              <AnnouncementItem item={selectedAnnouncement} language={language} />
              {forcedAnnouncementId === selectedAnnouncement.id && (
                <button
                  type="button"
                  onClick={() => {
                    markAnnouncementRead(selectedAnnouncement);
                    setForcedAnnouncementId(null);
                    setSelectedAnnouncementId(null);
                    setIsOpen(false);
                    const url = new URL(window.location.href);
                    url.searchParams.set("page", "agent");
                    window.location.assign(url.toString());
                  }}
                  className="w-full rounded-xl bg-sky-400 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  {copy.goToAgent}
                </button>
              )}
            </div>
          ) : items.length ? (
            <ul className="flex flex-col gap-2">
              {items.map((item) => {
                const { title, content } = getLocalizedAnnouncement(item, language);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => followAnnouncement(item)}
                      className="group w-full rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-left transition hover:border-sky-400/60 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                    >
                      <span className="flex items-start justify-between gap-3">
                        <span className="min-w-0">
                          <span className="block font-semibold text-amber-100">{title}</span>
                          <span className="mt-1 block line-clamp-2 whitespace-pre-wrap text-sm leading-6 text-slate-300">
                            {content}
                          </span>
                        </span>
                        <ArrowRight
                          aria-hidden="true"
                          className="mt-1 size-4 shrink-0 text-sky-300 transition-transform group-hover:translate-x-0.5"
                        />
                      </span>
                      <time className="mt-3 block text-xs text-slate-400">
                        {new Date(item.created_at).toLocaleString(language)}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm leading-6 text-slate-300">{fallback}</p>
          )}
        </div>
      </Modal>
    </>
  );
}
