export type AnnouncementDestination = {
  page: "subscribe" | "market" | "wallet" | "agent" | "settings";
  assetId?: string;
  section?: "nickname" | "agencyRelationship" | "telegramNotifications";
};

type AnnouncementText = { title?: string; content?: string };
export type AnnouncementRouteInput = AnnouncementText & {
  translations?: Partial<Record<string, AnnouncementText>>;
};
export type AnnouncementRouteAsset = {
  id: string;
  name: string;
  marketStartedAt?: string | null;
  isAeToken?: boolean;
  translations?: Partial<Record<string, { name?: string }>>;
};

const normalize = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");

const containsAny = (text: string, phrases: string[]) => {
  const normalizedText = normalize(text);
  return phrases.some((phrase) => normalizedText.includes(normalize(phrase)));
};

const assetNameLength = (asset: AnnouncementRouteAsset) =>
  Math.max(
    normalize(asset.name).length,
    ...Object.values(asset.translations ?? {}).map((translation) => normalize(translation?.name ?? "").length),
  );

const hasAssetName = (announcementText: string, normalizedText: string, name: string) => {
  const normalizedName = normalize(name);
  if (normalizedName.length < 2) return false;
  if (normalizedText.includes(normalizedName)) return true;

  const nameWords = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .match(/[a-z0-9]{3,}/g) ?? [];
  if (!nameWords.length) return false;

  const announcementWords = new Set(
    announcementText
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .match(/[a-z0-9]{3,}/g) ?? [],
  );
  const matchedWords = nameWords.filter((word) => announcementWords.has(word)).length;
  return matchedWords >= Math.min(2, nameWords.length);
};

const marketPhrases = [
  "二級市場", "二级市场", "二次市場", "二次市场", "交易市場", "交易市场", "掛單", "挂单", "成交", "市場走勢", "市场走势",
  "secondary market", "secondary trading", "market trading", "marketplace", "market listing", "new market listing", "new listing", "listing", "listings", "trade order", "sell order", "buy order", "order book", "market trend",
  "二次流通", "取引市場", "取引所", "注文", "2차 시장", "거래 시장", "장터", "ตลาดรอง", "ตลาดซื้อขาย", "thị trường thứ cấp", "giao dịch thứ cấp",
  "pasar sekunder", "pasar jual beli", "pasaran sekunder", "perdagangan sekunder", "mercado secundario", "mercado de negociação", "marché secondaire", "négociation secondaire",
  "sekundärmarkt", "sekundärhandel", "mercado secundário", "negociação secundária", "вторичный рынок", "вторичные торги", "السوق الثانوية", "التداول الثانوي", "द्वितीयक बाज़ार", "द्वितीयक व्यापार",
];

const walletPhrases = [
  "錢包", "钱包", "usdt", "jc餘額", "jc余额", "提領", "提领", "提现", "充值", "入金", "兌換", "兑换", "贖回", "赎回",
  "wallet", "withdraw", "withdrawal", "deposit", "top up", "exchange jc", "redeem jc", "redemption", "ウォレット", "出金", "入金", "換金",
  "지갑", "출금", "입금", "충전", "แลกเปลี่ยน", "กระเป๋า", "ถอนเงิน", "nạp tiền", "rút tiền", "ví", "đổi jc", "dompet", "penarikan", "setoran", "tukar jc",
  "dompet", "pengeluaran", "deposit", "cartera", "retiro", "depósito", "portefeuille", "retrait", "dépôt", "sekundär wallet", "geldbörse", "abheben", "einzahlung",
  "carteira", "saque", "depósito", "кошелек", "вывод", "пополнение", "محفظة", "سحب", "إيداع", "वॉलेट", "निकासी", "जमा",
];

const subscribePhrases = [
  "認購", "认购", "申購", "申购", "購買", "购买", "私募", "上架新標的", "上架新标的", "一級市場", "一级市场",
  "subscription", "subscribe", "subscribe now", "private placement", "primary market", "new offering", "invest in", "purchase asset",
  "申込み", "申し込み", "購入", "募集", "청약", "구독", "구매", "신규 청약", "จองซื้อ", "สมัครซื้อ", "đăng ký mua", "mua tài sản",
  "berlangganan", "langganan", "beli aset", "pasaran utama", "berlangganan aset", "suscripción", "comprar activo", "mercado primario", "souscription", "acheter un actif", "marché primaire",
  "zeichnung", "anlage zeichnen", "primärmarkt", "subscrição", "comprar ativo", "mercado primário", "подписка", "покупка актива", "первичный рынок", "الاكتتاب", "شراء الأصل", "السوق الأولية", "सब्सक्रिप्शन", "संपत्ति खरीदें", "प्राथमिक बाज़ार",
];

const agentPhrases = [
  "代理中心", "代理商", "分潤", "分润", "推薦獎金", "推荐奖金", "佣金", "推廣碼", "推广码", "referral code", "promo code", "promotion code", "commission", "referral", "agent program",
  "紹介コード", "紹介報酬", "代理店", "추천 코드", "추천 수수료", "대리점", "รหัสแนะนำ", "ค่าคอมมิชชั่น", "mã giới thiệu", "hoa hồng", "đại lý",
  "kode referral", "komisi", "agen", "kod rujukan", "komisen", "ejen", "código de referido", "comisión", "agente", "code de parrainage", "commission", "empfehlungscode", "provision",
  "código de indicação", "comissão", "agente", "реферальный код", "комиссия", "агент", "رمز الإحالة", "العمولة", "وكيل", "रेफ़रल कोड", "कमीशन", "एजेंट",
];

const settingsPhrases = [
  "設定", "设置", "帳號資訊", "账号信息", "個人資料", "个人资料", "通知設定", "通知设置", "暱稱", "昵称", "修改名稱", "修改名称",
  "settings", "account information", "profile", "notification settings", "nickname", "display name", "account settings", "ニックネーム", "プロフィール", "通知設定",
  "계정 설정", "프로필", "알림 설정", "별명", "ตั้งค่า", "โปรไฟล์", "การแจ้งเตือน", "cài đặt", "hồ sơ", "thông báo", "pengaturan", "profil", "notifikasi",
  "tetapan", "profil", "pemberitahuan", "ajustes", "perfil", "notificaciones", "paramètres", "profil", "notifications", "einstellungen", "profil", "benachrichtigungen",
  "configurações", "perfil", "notificações", "настройки", "профиль", "уведомления", "الإعدادات", "الملف الشخصي", "الإشعارات", "सेटिंग्स", "प्रोफ़ाइल", "सूचनाएं",
];

export function resolveAnnouncementDestination(
  item: AnnouncementRouteInput,
  assets: AnnouncementRouteAsset[] = [],
): AnnouncementDestination | null {
  const announcementText = [
    item.title,
    item.content,
    ...Object.values(item.translations ?? {}).flatMap((translation) => [translation?.title, translation?.content]),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
  const normalizedText = normalize(announcementText);

  const isNicknameAnnouncement = containsAny(announcementText, [
    "暱稱", "昵称", "更改暱稱", "修改暱稱", "更改昵称", "修改昵称", "修改名稱", "修改名称",
    "nickname", "display name", "change nickname", "change your name", "rename", "update your profile name",
    "ニックネーム", "별명", "ชื่อเล่น", "biệt danh", "nama panggilan", "apodo", "pseudo", "spitzname", "apelido", "никнейм", "الاسم المستعار", "उपनाम",
  ]);
  if (isNicknameAnnouncement) return { page: "settings", section: "nickname" };

  const mentionsTelegram = containsAny(announcementText, ["telegram", "telegram bot", "telegram notifications", "telegram notification"]);
  const mentionsNotificationSetup = containsAny(announcementText, [
    "通知", "推播", "通知設定", "通知设置", "telegram通知", "notification", "notifications", "notification settings", "alerts", "提醒", "綁定", "绑定", "設定", "设置", "enable", "setup", "connect",
    "แจ้งเตือน", "thông báo", "notifikasi", "pemberitahuan", "notificaciones", "notifications", "benachrichtigungen", "notificações", "уведомления", "الإشعارات", "सूचनाएं",
  ]);
  if (mentionsTelegram && mentionsNotificationSetup) {
    return { page: "settings", section: "telegramNotifications" };
  }

  if (containsAny(announcementText, ["推廣碼", "推广码", "推薦碼", "推荐码", "邀請碼", "邀请码", "referral code", "promo code", "promotion code", "紹介コード", "招待コード", "추천 코드", "초대 코드", "รหัสแนะนำ", "รหัสเชิญ", "mã giới thiệu", "mã mời", "kode referral", "kode undangan", "kod rujukan", "kod jemputan", "código de referido", "código de invitación", "code de parrainage", "code d'invitation", "empfehlungscode", "einladungscode", "código de indicação", "código de convite", "реферальный код", "код приглашения", "رمز الإحالة", "رمز الدعوة", "रेफ़रल कोड", "आमंत्रण कोड"])) {
    return { page: "settings", section: "agencyRelationship" };
  }

  const mentionedAsset = [...assets]
    .sort((left, right) => assetNameLength(right) - assetNameLength(left))
    .find((asset) => {
      const names = [asset.name, ...Object.values(asset.translations ?? {}).map((translation) => translation?.name)];
      return names.some((name) => Boolean(name?.trim() && hasAssetName(announcementText, normalizedText, name)));
    });

  if (mentionedAsset) {
    return {
      page: mentionedAsset.marketStartedAt && !mentionedAsset.isAeToken ? "market" : "subscribe",
      assetId: mentionedAsset.id,
    };
  }
  if (containsAny(announcementText, marketPhrases)) return { page: "market" };
  if (containsAny(announcementText, walletPhrases)) return { page: "wallet" };
  if (containsAny(announcementText, subscribePhrases)) return { page: "subscribe" };
  if (containsAny(announcementText, agentPhrases)) return { page: "agent" };
  if (containsAny(announcementText, settingsPhrases)) return { page: "settings" };
  return null;
}

export type { AnnouncementRouteAsset as AnnouncementAsset };
export type { AnnouncementRouteInput as Announcement };
