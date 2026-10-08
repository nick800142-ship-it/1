import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Bell } from "lucide-react";
import { Modal } from "@/components/Modal";
import { supabase } from "@/lib/supabase";
import { playNotificationSound, showSystemNotification } from "@/lib/pushNotifications";
import { interfaceText, useLanguage, usePlatform, type Asset } from "@/platform";

type AnnouncementTranslation = { title?: string; content?: string };
type Announcement = {
  id: string;
  title: string;
  content: string;
  translations?: Record<string, AnnouncementTranslation>;
  created_at: string;
};

type AnnouncementDestination = {
  page: "home" | "subscribe" | "market" | "wallet" | "agent" | "settings";
  section?: "nickname" | "agencyRelationship";
};

export function resolveAnnouncementDestination(
  item: Announcement,
  language: string,
  assets: Asset[] = [],
): AnnouncementDestination | null {
  const localized = getLocalizedAnnouncement(item, language);
  const text = `${item.title} ${item.content} ${localized.title} ${localized.content}`.toLowerCase();
  const mentionedAsset = assets.find((asset) => {
    const names = [asset.name, ...Object.values(asset.translations ?? {}).map((translation) => translation.name)];
    return names.some((name) => name?.trim() && text.includes(name.trim().toLowerCase()));
  });

  if (mentionedAsset) {
    return { page: mentionedAsset.marketStartedAt && !mentionedAsset.isAeToken ? "market" : "subscribe" };
  }
  if (/(推廣碼|推广码|推薦碼|推荐码|邀請碼|邀请码|referral code|promo code|promotion code|紹介コード|招待コード|추천 코드|초대 코드|รหัสแนะนำ|รหัสเชิญ|mã giới thiệu|mã mời|kode referral|kode undangan|kod rujukan|kod jemputan|código de referido|código de invitación|code de parrainage|code d.invit|empfehlungscode|einladungscode|código de indicação|código de convite|реферальный код|код приглашения|رمز الإحالة|رمز الدعوة|रेफ़रल कोड|आमंत्रण कोड)/i.test(text)) {
    return { page: "settings", section: "agencyRelationship" };
  }
  if (/(暱稱|昵称|nickname|display name|ニックネーム|별명|ชื่อเล่น|biệt danh|nama panggilan|apodo|pseudo|spitzname|apelido|никнейм|الاسم المستعار|उपनाम)/i.test(text)) {
    return { page: "settings", section: "nickname" };
  }
  if (/(二級市場|二级市场|掛單|挂单|成交|secondary market|二次市場|二次市场|注文|2차 시장|ตลาดรอง|thị trường thứ cấp|pasar sekunder|pasaran sekunder|mercado secundario|marché secondaire|sekundärmarkt|mercado secundário|вторичный рынок|السوق الثانوية|द्वितीयक बाज़ार)/i.test(text)) {
    return { page: "market" };
  }
  if (/(錢包|钱包|usdt|\bjc\b|提領|提现|充值|入金|wallet|withdraw|deposit|ウォレット|지갑|กระเป๋า|ví|dompet|dompet|cartera|portefeuille|wallet|carteira|кошелек|محفظة|वॉलेट)/i.test(text)) {
    return { page: "wallet" };
  }
  if (/(認購|认购|申購|申购|購買|购买|subscription|subscribe|申込み|청약|จองซื้อ|đăng ký mua|berlangganan|langgan|suscripción|souscription|zeichnung|subscrição|подписка|الاكتتاب|सब्सक्रिप्शन)/i.test(text)) {
    return { page: "subscribe" };
  }
  if (/(代理中心|分潤|分润|代理商|commission|agent|代理店|대리점|ตัวแทน|đại lý|agen|ejen|agente|代理|агент|وكيل|एजेंट)/i.test(text)) {
    return { page: "agent" };
  }
  if (/(設定|设置|帳號資訊|账号信息|settings|account information|設定|계정 설정|ตั้งค่า|cài đặt|pengaturan|tetapan|ajustes|paramètres|einstellungen|configurações|настройки|الإعدادات|सेटिंग्स)/i.test(text)) {
    return { page: "settings" };
  }
  return null;
}

function getLocalizedAnnouncement(item: Announcement, language: string) {
  const localized = item.translations?.[language];
  const traditionalChinese = item.translations?.["zh-TW"];
  const valid = (value?: string) => Boolean(value?.trim() && !value.includes("�"));
  return {
    title: valid(localized?.title)
      ? localized!.title!.trim()
      : valid(traditionalChinese?.title)
        ? traditionalChinese!.title!.trim()
        : item.title,
    content: valid(localized?.content)
      ? localized!.content!.trim()
      : valid(traditionalChinese?.content)
        ? traditionalChinese!.content!.trim()
        : item.content,
  };
}

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

export function AnnouncementFeed({ fallback }: { fallback?: string }) {
  const { language } = useLanguage();
  const { assets } = usePlatform();
  const [items, setItems] = useState<Announcement[]>([]);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [readStorageKey, setReadStorageKey] = useState("rwmt-read-announcements:session");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedAnnouncementId, setSelectedAnnouncementId] = useState<string | null>(null);

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

  if (!items.length && !fallback) return null;
  const selectedAnnouncement = items.find((item) => item.id === selectedAnnouncementId);
  const unreadCount = items.filter((item) => !readIds.includes(item.id)).length;
  const announcementLabel = interfaceText(language, "platformAnnouncements");
  const unreadLabel = {
    "zh-TW": `${unreadCount} 則未讀`, "zh-CN": `${unreadCount} 条未读`, en: `${unreadCount} unread`,
    ja: `${unreadCount}件未読`, ko: `${unreadCount}개 읽지 않음`, th: `ยังไม่อ่าน ${unreadCount} รายการ`,
    vi: `${unreadCount} chưa đọc`, id: `${unreadCount} belum dibaca`, ms: `${unreadCount} belum dibaca`,
    es: `${unreadCount} sin leer`, fr: `${unreadCount} non lu`, de: `${unreadCount} ungelesen`,
    pt: `${unreadCount} não lidas`, ru: `Непрочитано: ${unreadCount}`, ar: `${unreadCount} غير مقروء`, hi: `${unreadCount} अपठित`,
  }[language];
  const markAnnouncementRead = (item: Announcement) => {
    if (readIds.includes(item.id)) return;
    const nextReadIds = [...readIds, item.id];
    setReadIds(nextReadIds);
    try {
      sessionStorage.setItem(readStorageKey, JSON.stringify(nextReadIds));
    } catch {
      // Keep the current view usable when browser storage is unavailable.
    }
  };
  const openAnnouncement = (item: Announcement) => {
    setSelectedAnnouncementId(item.id);
    markAnnouncementRead(item);
  };
  const followAnnouncement = (item: Announcement) => {
    const destination = resolveAnnouncementDestination(item, language, assets);
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
            setSelectedAnnouncementId(null);
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
        onClose={() => {
          setIsOpen(false);
          setSelectedAnnouncementId(null);
        }}
        title={announcementLabel}
        closeLabel={interfaceText(language, "close")}
        centered
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
                          <span className="mt-1 block line-clamp-2 text-sm leading-6 text-slate-300">
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
