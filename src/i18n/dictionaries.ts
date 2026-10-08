export const SUPPORTED_LOCALES = [
  "zh-TW", "zh-CN", "en", "ja", "ko", "th", "vi", "id", "ms", "es", "fr", "de", "pt", "ru", "ar", "hi",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];
export interface MessageTree { [key: string]: string | MessageTree; }

const common = {
  common: {
    submit: "提交", cancel: "取消", close: "關閉", save: "儲存", saving: "儲存中…", loading: "載入中…",
    search: "搜尋", confirm: "確認", retry: "重試", copy: "複製", copied: "已複製", noData: "目前沒有資料",
    buy: "買入", sell: "賣出", quantity: "數量", amount: "金額", unitPrice: "單價", total: "合計", fee: "手續費", time: "時間",
  },
  navigation: {
    home: "首頁", subscribe: "私募認購", market: "二級市場", wallet: "錢包", agent: "代理中心", settings: "設定",
  },
  agent: {
    title: "代理營運中心", teamMembers: "團隊會員", activeMembersThisMonth: "本月新增有效會員",
    personalBonus: "篩選期間個人獎金", teamBonus: "篩選期間團隊獎金", qrReferral: "QR Code 推廣碼",
    referralLink: "專屬推廣連結", copyReferralLink: "複製推廣連結", memberRecords: "會員交易與分潤紀錄",
    searchMembers: "依名稱查詢", startDate: "開始日期", endDate: "結束日期", clearDates: "清除時間",
    paid: "已發放", pending: "待發放", noTransactions: "所選時間內沒有交易紀錄", noCommissions: "所選時間內沒有分潤紀錄",
    qrDescription: "掃描 QR Code 後會開啟網站登入／註冊畫面。用戶完成登入後，系統會自動將此推廣碼綁定至帳號並建立代理層級。",
  },
  market: {
    orderBook: "掛單現況", noOrders: "目前沒有掛單", direction: "方向", filledQuantity: "成交份額",
    tradedAmount: "成交額", platformFee: "平台費", netAmount: "淨額", orderQuantity: "掛單份額", orderTotal: "掛單總額",
    h2h: "個人對個人交易市場", description: "同標的、同計價幣且跨錢包的掛單，買方出價達到賣價時會依價格與時間優先自動撮合；未成交部分仍由合約託管並留在訂單簿。賣方掛單一次性收取 1 JC（取消不退），成交另收 1% 費用，鏈上 Gas 由平台代付。", noMatchingAssets: "目前沒有符合條件的二級市場標的", currentPrice: "現價（最新成交價）", referencePrice: "參考價格（JC）", subscriptionPrice: "認購原價", enterMarket: "進入市場", buyOrder: "掛買單", sellOrder: "掛賣單", orderPlaced: "掛單已建立", cancelOrder: "取消掛單", syncRetry: "重試同步"
  },
} satisfies MessageTree;

const overrides: Partial<Record<Locale, MessageTree>> = {
  en: {
    common: { submit: "Submit", cancel: "Cancel", close: "Close", save: "Save", saving: "Saving…", loading: "Loading…", search: "Search", confirm: "Confirm", retry: "Retry", copy: "Copy", copied: "Copied", noData: "No data", buy: "Buy", sell: "Sell", quantity: "Quantity", amount: "Amount", unitPrice: "Unit price", total: "Total", fee: "Fee", time: "Time" },
    navigation: { home: "Home", subscribe: "Private subscription", market: "Secondary market", wallet: "Wallet", agent: "Agent center", settings: "Settings" },
    agent: { title: "Agent operations center", teamMembers: "Team members", activeMembersThisMonth: "New active members this month", personalBonus: "Personal bonus for selected period", teamBonus: "Team bonus for selected period", qrReferral: "QR referral", referralLink: "Dedicated referral link", copyReferralLink: "Copy referral link", memberRecords: "Member transactions and commissions", searchMembers: "Search by name", startDate: "Start date", endDate: "End date", clearDates: "Clear dates", paid: "Paid", pending: "Pending", noTransactions: "No transactions in the selected period", noCommissions: "No commissions in the selected period", qrDescription: "Scanning the QR code opens the website login or registration page. After login, the referral code is linked to the account and an agent level is created." },
    market: { orderBook: "Order book", noOrders: "No orders", direction: "Direction", filledQuantity: "Filled quantity", tradedAmount: "Traded amount", platformFee: "Platform fee", netAmount: "Net amount", orderQuantity: "Order quantity", orderTotal: "Order total", h2h: "Peer-to-peer market", description: "Orders for the same asset and currency are matched automatically by price and time priority. Unfilled quantities remain in escrow and the order book. Sellers pay a one-time 1 JC listing fee and a 1% settlement fee; the platform covers on-chain gas.", noMatchingAssets: "No secondary-market assets match your filters", currentPrice: "Current price (latest trade)", referencePrice: "Reference price (JC)", subscriptionPrice: "Subscription price", enterMarket: "Open market", buyOrder: "Place buy order", sellOrder: "Place sell order", orderPlaced: "Order placed", cancelOrder: "Cancel order", syncRetry: "Retry sync" },
  },
  "zh-CN": { common: { submit: "提交", cancel: "取消", close: "关闭", save: "保存", saving: "保存中…", loading: "加载中…", search: "搜索", confirm: "确认", retry: "重试", copy: "复制", copied: "已复制", noData: "暂无数据", buy: "买入", sell: "卖出", quantity: "数量", amount: "金额", unitPrice: "单价", total: "合计", fee: "手续费", time: "时间" }, navigation: { home: "首页", subscribe: "私募认购", market: "二级市场", wallet: "钱包", agent: "代理中心", settings: "设置" } },
  hi: { agent: { title: "एजेंसी संचालन केंद्र", teamMembers: "टीम सदस्य", activeMembersThisMonth: "इस महीने के नए सक्रिय सदस्य", personalBonus: "चयनित अवधि का व्यक्तिगत बोनस", teamBonus: "चयनित अवधि का टीम बोनस", qrReferral: "QR कोड रेफ़रल", referralLink: "विशेष रेफ़रल लिंक", copyReferralLink: "रेफ़रल लिंक कॉपी करें", memberRecords: "सदस्य लेन-देन और कमीशन रिकॉर्ड", searchMembers: "नाम से खोजें", startDate: "आरंभ तिथि", endDate: "समाप्ति तिथि", clearDates: "अवधि साफ़ करें", paid: "भुगतान किया गया", pending: "भुगतान लंबित", noTransactions: "चयनित अवधि में कोई लेन-देन नहीं है", noCommissions: "चयनित अवधि में कोई कमीशन रिकॉर्ड नहीं है", qrDescription: "QR कोड स्कैन करने पर वेबसाइट का लॉगिन या पंजीकरण पृष्ठ खुलेगा। लॉगिन के बाद रेफ़रल कोड खाते से जुड़ जाएगा और एजेंट स्तर बनाया जाएगा।" }, market: { h2h: "व्यक्ति-से-व्यक्ति बाज़ार", description: "समान संपत्ति और मुद्रा के ऑर्डर कीमत और समय की प्राथमिकता से अपने आप मिलते हैं। अधूरे हिस्से एस्क्रो और ऑर्डर बुक में रहते हैं। विक्रेता से एक बार 1 JC शुल्क और निपटान पर 1% शुल्क लिया जाता है; ऑन-चेन गैस प्लेटफ़ॉर्म वहन करता है।", noMatchingAssets: "फ़िल्टर से मेल खाने वाली कोई द्वितीयक बाज़ार संपत्ति नहीं है", currentPrice: "वर्तमान कीमत", referencePrice: "संदर्भ कीमत (JC)", subscriptionPrice: "सब्सक्रिप्शन कीमत", enterMarket: "बाज़ार खोलें", buyOrder: "खरीद ऑर्डर", sellOrder: "बिक्री ऑर्डर", orderPlaced: "ऑर्डर बनाया गया", cancelOrder: "ऑर्डर रद्द करें", syncRetry: "सिंक फिर आज़माएँ" } },
};

export const dictionaries: Record<Locale, MessageTree> = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [locale, { ...common, ...(overrides[locale] ?? {}) }]),
) as unknown as Record<Locale, MessageTree>;

export function getMessage(locale: Locale, key: string, variables?: Record<string, string | number>) {
  const value = key.split(".").reduce<unknown>((current, part) => (current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined), dictionaries[locale]);
  const fallback = key.split(".").reduce<unknown>((current, part) => (current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined), dictionaries.en);
  const text = typeof value === "string" ? value : typeof fallback === "string" ? fallback : key;
  return Object.entries(variables ?? {}).reduce((result, [name, replacement]) => result.split(`{${name}}`).join(String(replacement)), text);
}

export function isLocale(value: string | null): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
