import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "@/lib/supabase";

export type Asset = {
  id: string;
  name: string;
  location: string;
  address: string;
  image: string;
  price: number;
  change: number;
  available: number;
  total: number;
  apy: number;
  valuation: number;
  endsAt: string;
  marketStartedAt?: string | null;
  priceLockedUntil?: string | null;
  history: string[];
  comparables: string[];
  advantages: string[];
};
export type Transaction = {
  id: string;
  type: "buy" | "sell" | "deposit" | "withdraw" | "dividend";
  assetId?: string;
  asset: string;
  quantity?: number;
  gross: number;
  fee: number;
  net: number;
  date: string;
  createdAt: string;
  hash: string;
  status: "confirmed";
};
export type Holding = { assetId: string; tokens: number };

export const ASSETS: Asset[] = [
  {
    id: "mel-southbank",
    name: "墨爾本 Southbank 河景公寓",
    location: "Southbank, Melbourne, Australia",
    address: "180 City Road, Southbank VIC 3006, Australia",
    image:
      "https://images.pexels.com/photos/1517586/pexels-photo-1517586.jpeg?auto=compress&cs=tinysrgb&w=1600",
    price: 1.02,
    change: 2.4,
    available: 8420,
    total: 25000,
    apy: 8.8,
    valuation: 2500000,
    endsAt: "2026-12-31T18:00:00Z",
    history: [
      "2018 年完工並取得使用執照",
      "2022 年完成全面翻新",
      "2026 年由獨立估值機構評估為 250 萬 USDT",
    ],
    comparables: [
      "Southbank 一房均價：740,000 USDT",
      "每平方公尺均價：11,280 USDT",
      "同區租金年增率：5.2%",
    ],
    advantages: ["步行 8 分鐘到 CBD", "雅拉河永久景觀", "平均出租率 96.8%"],
  },
  {
    id: "tokyo-shibuya",
    name: "東京澀谷商業大樓",
    location: "Shibuya, Tokyo, Japan",
    address: "2-24-12 Shibuya, Shibuya-ku, Tokyo",
    image:
      "https://images.pexels.com/photos/2506947/pexels-photo-2506947.jpeg?auto=compress&cs=tinysrgb&w=1200",
    price: 0.87,
    change: -1.1,
    available: 12300,
    total: 40000,
    apy: 7.2,
    valuation: 3200000,
    endsAt: "2027-02-28T18:00:00Z",
    history: ["2016 年完工", "2024 年完成節能升級", "2026 年 SPV 收購完成"],
    comparables: [
      "澀谷商辦每坪均價：42,000 USDT",
      "區域空置率：2.1%",
      "年租金成長：4.7%",
    ],
    advantages: ["澀谷站步行 3 分鐘", "長期企業租約", "核心商業區稀缺供給"],
  },
  {
    id: "singapore-marina",
    name: "新加坡 Marina Bay 景觀宅",
    location: "Marina Bay, Singapore",
    address: "12 Marina Boulevard, Singapore 018982",
    image:
      "https://images.pexels.com/photos/7746733/pexels-photo-7746733.jpeg?auto=compress&cs=tinysrgb&w=1200",
    price: 1.35,
    change: 3.8,
    available: 5600,
    total: 18000,
    apy: 9.1,
    valuation: 4800000,
    endsAt: "2027-03-31T18:00:00Z",
    history: [
      "2020 年取得 TOP",
      "2025 年完成室內升級",
      "2026 年完成鏈上資產驗證",
    ],
    comparables: [
      "灣區豪宅中位價：3.9M USDT",
      "每平方呎均價：2,850 USDT",
      "租賃需求年增：6.4%",
    ],
    advantages: ["濱海灣核心景觀", "國際金融中心旁", "高資產租戶需求"],
  },
  {
    id: "london-canary",
    name: "倫敦 Canary Wharf 辦公室",
    location: "Canary Wharf, London, UK",
    address: "25 Canada Square, London E14 5LQ, UK",
    image:
      "https://images.pexels.com/photos/672532/pexels-photo-672532.jpeg?auto=compress&cs=tinysrgb&w=1200",
    price: 0.94,
    change: 0.6,
    available: 9800,
    total: 30000,
    apy: 6.5,
    valuation: 2900000,
    endsAt: "2027-06-30T18:00:00Z",
    history: [
      "2015 年取得 BREEAM Excellent",
      "2023 年公共空間翻新",
      "2026 年估值更新",
    ],
    comparables: [
      "甲級辦公室收益率：5.8%",
      "平均租金：每呎 58 USDT",
      "空置率低於區域平均",
    ],
    advantages: ["Elizabeth Line 直達", "ESG 認證建築", "多元企業租戶組合"],
  },
];

type TradeResult = { ok: boolean; message: string };
type PlatformContextValue = {
  balance: number;
  holdings: Holding[];
  transactions: Transaction[];
  assets: Asset[];
  loading: boolean;
  trade: (
    assetId: string,
    type: "buy" | "sell" | "private_buy",
    quantity: number,
  ) => Promise<TradeResult>;
  refresh: () => Promise<void>;
};
const PlatformContext = createContext<PlatformContextValue | null>(null);
const assetDetails = new Map(ASSETS.map((asset) => [asset.id, asset]));
export function PlatformProvider({ children }: { children: ReactNode }) {
  const [balance, setBalance] = useState(0);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [assets, setAssets] = useState(ASSETS);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const [{ data: placements }, { data: ledger }, { data: positions }] =
      await Promise.all([
        supabase.from("private_placements").select("*").order("created_at"),
        supabase
          .from("asset_ledger")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase.from("holdings").select("*"),
      ]);
    if (placements)
      setAssets(
        placements.map((row) => {
          const details = assetDetails.get(row.id) ?? ASSETS[0];
          return {
            ...details,
            id: row.id,
            name: row.name,
            location: row.location,
            address: row.address,
            image: row.image,
            price: Number(row.price),
            change: Number(row.change),
            available: Number(row.available),
            total: Number(row.total_supply),
            apy: Number(row.apy),
            valuation: Number(row.valuation),
            endsAt: row.ends_at,
            marketStartedAt: row.market_started_at,
            priceLockedUntil: row.price_locked_until,
          };
        }),
      );
    if (ledger) {
      setBalance(ledger.reduce((sum, row) => sum + Number(row.amount), 0));
      setTransactions(
        ledger.map((row) => {
          const asset = assetDetails.get(row.asset_id);
          const gross = Math.abs(Number(row.metadata?.gross ?? row.amount));
          const fee = Number(row.metadata?.fee ?? 0);
          const map: Record<string, Transaction["type"]> = {
            sandbox_deposit: "deposit",
            private_purchase: "buy",
            secondary_buy: "buy",
            secondary_sell: "sell",
            commission: "dividend",
          };
          return {
            id: row.id,
            type: map[row.entry_type] ?? "dividend",
            assetId: row.asset_id ?? undefined,
            asset:
              asset?.name ??
              (row.entry_type === "sandbox_deposit" ? "測試 USDT" : "代理分潤"),
            quantity: row.quantity ? Number(row.quantity) : undefined,
            gross,
            fee,
            net: Number(row.amount),
            date: new Date(row.created_at).toLocaleString(),
            createdAt: row.created_at,
            hash: row.id,
            status: "confirmed",
          };
        }),
      );
    }
    if (positions)
      setHoldings(
        positions.map((row) => ({
          assetId: row.asset_id,
          tokens: Number(row.quantity),
        })),
      );
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const trade = async (
    assetId: string,
    type: "buy" | "sell" | "private_buy",
    quantity: number,
  ): Promise<TradeResult> => {
    if (!Number.isFinite(quantity) || quantity <= 0)
      return { ok: false, message: "請輸入有效份額" };
    const side =
      type === "private_buy"
        ? "private_buy"
        : type === "buy"
          ? "secondary_buy"
          : "secondary_sell";
    const { data: filledTrade, error } = await supabase.rpc(
      "execute_sandbox_trade",
      {
        asset_key: assetId,
        trade_side: side,
        trade_quantity: quantity,
        request_key: crypto.randomUUID(),
      },
    );
    if (error) {
      const messages: Record<string, string> = {
        "placement ended": "私募已結束",
        "insufficient balance": "USDT 餘額不足",
        "insufficient holdings": "持有份額不足",
        "insufficient supply": "可購份額不足",
        "price update cooldown": "此標的剛完成調價，一分鐘內暫停新增掛單",
      };
      return {
        ok: false,
        message: messages[error.message] ?? "交易未完成，請稍後再試",
      };
    }

    // execute_sandbox_trade returns only after the balance and holdings ledger
    // updates have committed, so commission processing never runs for a failed,
    // pending, or cancelled order. Private purchases credit the buyer, while
    // secondary-market commissions are generated for the successful seller.
    if (type === "private_buy" || type === "sell") {
      const tradeRow = filledTrade as {
        user_id?: string;
        asset_id?: string;
        amount?: number | string;
        metadata?: { gross?: number | string };
      } | null;
      const grossAmount = Math.abs(
        Number(tradeRow?.metadata?.gross ?? tradeRow?.amount ?? 0),
      );

      if (!tradeRow?.user_id || !tradeRow.asset_id || grossAmount <= 0) {
        await refresh();
        return {
          ok: true,
          message: "交易成功，但分潤資料不完整，請聯絡管理員",
        };
      }

      const { error: commissionError } = await supabase.rpc(
        "process_commission",
        {
          p_trader_id: tradeRow.user_id,
          p_amount: grossAmount,
          p_project_id: tradeRow.asset_id,
          p_market_type: type === "private_buy" ? "private" : "secondary",
        },
      );

      if (commissionError) {
        await refresh();
        return {
          ok: true,
          message: "交易成功，但分潤處理失敗，請聯絡管理員",
        };
      }
    }

    await refresh();
    return { ok: true, message: "交易成功" };
  };
  return (
    <PlatformContext.Provider
      value={{
        balance,
        holdings,
        transactions,
        assets,
        loading,
        trade,
        refresh,
      }}
    >
      {children}
    </PlatformContext.Provider>
  );
}
export const usePlatform = () => {
  const v = useContext(PlatformContext);
  if (!v) throw new Error("PlatformProvider missing");
  return v;
};

export const LANGUAGES = [
  ["zh-TW", "繁體中文"],
  ["zh-CN", "简体中文"],
  ["en", "English"],
  ["ja", "��本語"],
  ["ko", "한국어"],
  ["th", "ไทย"],
  ["vi", "Tiếng Việt"],
  ["id", "Bahasa Indonesia"],
  ["ms", "Bahasa Melayu"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["ar", "العربية"],
  ["hi", "हिन्दी"],
] as const;
type Lang = (typeof LANGUAGES)[number][0];
const words: Record<Lang, string[]> = {
  "zh-TW": [
    "首頁",
    "二級市場",
    "錢包",
    "設定",
    "精選項目",
    "探索經鏈上驗證的房地產代幣化資產",
    "公告",
    "了解詳情",
    "買入",
    "賣出",
    "可用餘額",
    "交易紀錄",
    "手續費",
    "實收金額",
    "語言",
    "帳戶與安全設定",
    "已通過 KYC",
    "充值",
    "提領",
    "持倉資產",
    "近期交易",
    "模擬鏈上",
    "確認交易",
    "取消",
    "份額",
    "每份價格",
    "成交總額",
    "掛單簿",
    "資產詳情",
  ],
  "zh-CN": [
    "首页",
    "二级市场",
    "钱包",
    "设置",
    "精选项目",
    "探索经链上验证的房地产代币化资产",
    "公告",
    "了解详情",
    "买入",
    "卖出",
    "可用余额",
    "交易记录",
    "手续费",
    "实收金额",
    "语言",
    "账户与安全设置",
    "已通过 KYC",
    "充值",
    "提现",
    "持仓资产",
    "近期交易",
    "模拟上链",
    "确认交易",
    "取消",
    "份额",
    "每份价格",
    "成交总额",
    "挂单簿",
    "资产详情",
  ],
  en: [
    "Home",
    "Secondary market",
    "Wallet",
    "Settings",
    "Featured assets",
    "Explore blockchain-verified tokenized real estate",
    "Announcements",
    "View details",
    "Buy",
    "Sell",
    "Available balance",
    "Trade history",
    "Fee",
    "Net amount",
    "Language",
    "Account and security settings",
    "KYC verified",
    "Deposit",
    "Withdraw",
    "Holdings",
    "Recent transactions",
    "Simulated on-chain",
    "Confirm trade",
    "Cancel",
    "Units",
    "Price per unit",
    "Gross amount",
    "Order book",
    "Asset details",
  ],
  ja: [
    "ホーム",
    "二次市場",
    "ウォレット",
    "設定",
    "注目資産",
    "ブロックチェーン検証済み不動産を探索",
    "お知らせ",
    "詳細を見る",
    "購入",
    "売却",
    "利用可能残高",
    "取引履歴",
    "手数料",
    "受取額",
    "言語",
    "アカウントとセキュリティ",
    "KYC認証済み",
    "入金",
    "出金",
    "保有資産",
    "最近の取引",
    "オンチェーン模擬",
    "取引確認",
    "キャンセル",
    "口数",
    "単価",
    "取引総額",
    "注文板",
    "資産詳細",
  ],
  ko: [
    "홈",
    "2차 시장",
    "지갑",
    "설정",
    "추천 자산",
    "블록체인 검증 부동산 토큰 탐색",
    "공지",
    "상세 보기",
    "구매",
    "판매",
    "사용 가능 잔액",
    "거래 내역",
    "수수료",
    "실수령액",
    "언어",
    "계정 및 보안 설정",
    "KYC 인증 완료",
    "입금",
    "출금",
    "보유 자산",
    "최근 거래",
    "온체인 시뮬레이션",
    "거래 확인",
    "취소",
    "수량",
    "단가",
    "거래 총액",
    "주문장",
    "자산 상세",
  ],
  th: [
    "หน้าหลัก",
    "ตลาดรอง",
    "กระเป๋า",
    "ตั้งค่า",
    "สินทรัพย์แนะนำ",
    "สำรวจอสังหาฯ โทเคนที่ตรวจสอบแล้ว",
    "ประกาศ",
    "ดูรายละเอียด",
    "ซื้อ",
    "ขาย",
    "ยอดคงเหลือ",
    "ประวัติการซื้อขาย",
    "ค่าธรรมเนียม",
    "ยอดสุทธิ",
    "ภาษา",
    "บัญชีและความปลอดภัย",
    "ยืนยัน KYC แล้ว",
    "ฝาก",
    "ถอน",
    "สินทรัพย์ถือครอง",
    "ธุรกรรมล่า����ด",
    "จำลองบนเชน",
    "ยืนยันรายการ",
    "ยกเลิก",
    "หน่วย",
    "ราคาต่อหน่วย",
    "ยอดรวม",
    "สมุดคำสั่ง",
    "รายละเอียดสินทรัพย์",
  ],
  vi: [
    "Trang chủ",
    "Thị trường thứ cấp",
    "Ví",
    "Cài đặt",
    "Tài sản nổi bật",
    "Khám phá bất động sản token hóa đã xác minh",
    "Thông báo",
    "Xem chi tiết",
    "Mua",
    "Bán",
    "Số dư khả dụng",
    "Lịch sử giao dịch",
    "Phí",
    "Số tiền thực nhận",
    "Ngôn ngữ",
    "Tài khoản và bảo mật",
    "Đã xác minh KYC",
    "Nạp",
    "Rút",
    "Tài sản nắm giữ",
    "Giao dịch gần đây",
    "Mô phỏng on-chain",
    "Xác nhận",
    "Hủy",
    "Phần",
    "Giá mỗi phần",
    "Tổng giao dịch",
    "Sổ lệnh",
    "Chi tiết tài sản",
  ],
  id: [
    "Beranda",
    "Pasar sekunder",
    "Dompet",
    "Pengaturan",
    "Aset unggulan",
    "Jelajahi real estat token terverifikasi",
    "Pengumuman",
    "Lihat detail",
    "Beli",
    "Jual",
    "Saldo tersedia",
    "Riwayat perdagangan",
    "Biaya",
    "Jumlah bersih",
    "Bahasa",
    "Akun dan keamanan",
    "KYC terverifikasi",
    "Setor",
    "Tarik",
    "Kepemilikan",
    "Transaksi terbaru",
    "Simulasi on-chain",
    "Konfirmasi",
    "Batal",
    "Unit",
    "Harga per unit",
    "Jumlah kotor",
    "Buku pesanan",
    "Detail aset",
  ],
  ms: [
    "Utama",
    "Pasaran sekunder",
    "Dompet",
    "Tetapan",
    "Aset pilihan",
    "Terokai hartanah token yang disahkan",
    "Pengumuman",
    "Lihat butiran",
    "Beli",
    "Jual",
    "Baki tersedia",
    "Sejarah dagangan",
    "Yuran",
    "Jumlah bersih",
    "Bahasa",
    "Akaun dan keselamatan",
    "KYC disahkan",
    "Deposit",
    "Pengeluaran",
    "Pegangan",
    "Transaksi terkini",
    "Simulasi atas rantaian",
    "Sahkan dagangan",
    "Batal",
    "Unit",
    "Harga seunit",
    "Jumlah kasar",
    "Buku pesanan",
    "Butiran aset",
  ],
  es: [
    "Inicio",
    "Mercado secundario",
    "Cartera",
    "Ajustes",
    "Activos destacados",
    "Explora inmuebles tokenizados verificados",
    "Anuncios",
    "Ver detalles",
    "Comprar",
    "Vender",
    "Saldo disponible",
    "Historial",
    "Comisión",
    "Importe neto",
    "Idioma",
    "Cuenta y seguridad",
    "KYC verificado",
    "Depositar",
    "Retirar",
    "Posiciones",
    "Transacciones recientes",
    "Simulación en cadena",
    "Confirmar",
    "Cancelar",
    "Unidades",
    "Precio unitario",
    "Importe bruto",
    "Libro de órdenes",
    "Detalles del activo",
  ],
  fr: [
    "Accueil",
    "Marché secondaire",
    "Portefeuille",
    "Paramètres",
    "Actifs vedettes",
    "Explorez les biens tokenisés vérifiés",
    "Annonces",
    "Voir détails",
    "Acheter",
    "Vendre",
    "Solde disponible",
    "Historique",
    "Frais",
    "Montant net",
    "Langue",
    "Compte et sécurité",
    "KYC vérifié",
    "Déposer",
    "Retirer",
    "Positions",
    "Transactions récentes",
    "Simulation on-chain",
    "Confirmer",
    "Annuler",
    "Unités",
    "Prix unitaire",
    "Montant brut",
    "Carnet d’ordres",
    "Détails de l’actif",
  ],
  de: [
    "Start",
    "Sekundärmarkt",
    "Wallet",
    "Einstellungen",
    "Ausgewählte Assets",
    "Verifizierte tokenisierte Immobilien entdecken",
    "Ankündigungen",
    "Details",
    "Kaufen",
    "Verkaufen",
    "Verfügbares Guthaben",
    "Handelsverlauf",
    "Gebühr",
    "Nettobetrag",
    "Sprache",
    "Konto und Sicherheit",
    "KYC verifiziert",
    "Einzahlen",
    "Auszahlen",
    "Bestände",
    "Letzte Transaktionen",
    "On-Chain-Simulation",
    "Bestätigen",
    "Abbrechen",
    "Anteile",
    "Preis je Anteil",
    "Bruttobetrag",
    "Orderbuch",
    "Asset-Details",
  ],
  pt: [
    "Início",
    "Mercado secundário",
    "Carteira",
    "Definições",
    "Ativos em destaque",
    "Explore imóveis tokenizados verificados",
    "Anúncios",
    "Ver detalhes",
    "Comprar",
    "Vender",
    "Saldo disponível",
    "Histórico",
    "Taxa",
    "Valor líquido",
    "Idioma",
    "Conta e segurança",
    "KYC verificado",
    "Depositar",
    "Retirar",
    "Posições",
    "Transações recentes",
    "Simulação on-chain",
    "Confirmar",
    "Cancelar",
    "Unidades",
    "Preço unitário",
    "Valor bruto",
    "Livro de ordens",
    "Detalhes do ativo",
  ],
  ru: [
    "Главная",
    "Вторичный рынок",
    "Кошелёк",
    "Настройки",
    "Избранные активы",
    "Токенизированная недвижимость с проверкой",
    "Объявления",
    "Подробнее",
    "Купить",
    "Продать",
    "Доступный баланс",
    "История сделок",
    "Комиссия",
    "Чистая сумма",
    "Язык",
    "Аккаунт и безопасность",
    "KYC подтвержден",
    "Пополнить",
    "Вывести",
    "Активы",
    "Последние операции",
    "Симуляция в сети",
    "Подтвердить",
    "Отмена",
    "Доли",
    "Цена доли",
    "Общая сумма",
    "Книга заявок",
    "Детали актива",
  ],
  ar: [
    "الرئيسية",
    "السوق الثانوية",
    "المحفظة",
    "الإعدادات",
    "الأصول المميزة",
    "استكشف العقارات المرمزة الموثقة",
    "الإعلانات",
    "عرض التفاصيل",
    "شراء",
    "بيع",
    "الرصيد المتاح",
    "سجل التداول",
    "الرسوم",
    "المبلغ الصافي",
    "اللغة",
    "الحساب والأمان",
    "تم التحقق من KYC",
    "إيداع",
    "سحب",
    "المقتنيات",
    "المعاملات الأخيرة",
    "محاكاة على السلسلة",
    "تأكيد",
    "إلغاء",
    "الوحدات",
    "سعر الوحدة",
    "المبلغ الإجمالي",
    "دفتر الطلبات",
    "تفاصيل الأصل",
  ],
  hi: [
    "होम",
    "द्वितीयक बाज़ार",
    "वॉलेट",
    "सेटिंग्स",
    "विशेष एसेट",
    "सत्यापित टोकन रियल एस्टेट खोजें",
    "घोषणाएँ",
    "विवरण देखें",
    "खरीदें",
    "बेचें",
    "उपलब्ध बैलेंस",
    "ट्रेड इतिहास",
    "शुल्क",
    "शुद्ध राशि",
    "भाषा",
    "खाता और सुरक्षा",
    "KYC सत्यापित",
    "जमा",
    "निकासी",
    "होल्डिंग्स",
    "हाल के लेनदेन",
    "ऑन-चेन सिमुलेशन",
    "पुष्टि करें",
    "रद्द करें",
    "यूनिट",
    "प्रति यूनिट मूल्य",
    "कुल राशि",
    "ऑर्डर बुक",
    "एसेट विवरण",
  ],
};
const keys = [
  "home",
  "market",
  "wallet",
  "settings",
  "featured",
  "subtitle",
  "announcements",
  "details",
  "buy",
  "sell",
  "balance",
  "history",
  "fee",
  "net",
  "language",
  "accountSecurity",
  "kycPassed",
  "deposit",
  "withdraw",
  "holdings",
  "recent",
  "simulated",
  "confirm",
  "cancel",
  "units",
  "unitPrice",
  "gross",
  "orderbook",
  "assetDetails",
] as const;
type Key = (typeof keys)[number];
const extraZh: Record<string, string> = {
  announcement:
    "所有交易以 USDT 結算；買入免平台費，賣出收成交額 1% + 1 USDT。本平台目前為完整前端模擬，不會送出真實鏈上交易。",
  more: "更多項目",
  valuation: "總資產估值",
  expectedApy: "預計 APY",
  verification: "資產驗證",
  fullAddress: "完整地址",
  propertyHistory: "物件歷史",
  nearbyPricing: "周邊定價",
  advantages: "投資優勢",
  buyFee: "買入平台手續費：0 USDT",
  liveMatching: "USDT 即時撮合 · 所有鏈上狀態均為前端模擬",
  all: "全部",
  rising: "上漲",
  falling: "下跌",
  available: "可購",
  backMarket: "返回市場",
  candlestick: "K 線圖",
  asks: "賣單",
  bids: "買單",
  owned: "持有份額",
  totalAssets: "總資產價值",
  networkFee: "網路手續費",
  status: "狀態",
  confirmed: "已確認",
  preferences: "偏好設定",
  notifications: "通知",
  changeLanguage: "變更整個介面語言",
  identity: "身分驗證",
  verifiedDate: "驗證日期",
  level: "等級",
  price: "價格通知",
  dividend: "收益分配通知",
  listings: "新項目通知",
  receiveAlerts: "接收帳戶與資產通知",
  investor: "投資者",
  subscribeEyebrow: "初級市場",
  subscribeTitle: "認購",
  subscribeDescription: "所有尚未進入二級市場的標的物。",
  subscribing: "認購中",
  soldOut: "已售罄",
  ended: "已結束",
  subscriptionUnitPrice: "認購單價",
  subscribeNow: "立即認購",
  unavailableSubscribe: "目前不可認購",
  noSubscriptions: "目前沒有可顯示的非二級市場標的。",
  availableBalance: "可用餘額",
  subscriptionUnits: "認購份額",
  subscriptionTotal: "認購總額",
  confirmSubscription: "確認認購",
};
const extraEn: Record<string, string> = {
  announcement:
    "All trades settle in USDT. Buying has no platform fee; selling costs 1% of the gross amount + 1 USDT. This platform is a complete front-end simulation and sends no real on-chain transaction.",
  more: "More assets",
  valuation: "Total asset valuation",
  expectedApy: "Expected APY",
  verification: "Asset verification",
  fullAddress: "Full address",
  propertyHistory: "Property history",
  nearbyPricing: "Nearby pricing",
  advantages: "Investment advantages",
  buyFee: "Buy platform fee: 0 USDT",
  liveMatching: "Live USDT matching · All on-chain states are simulated",
  all: "All",
  rising: "Rising",
  falling: "Falling",
  available: "Available",
  backMarket: "Back to market",
  candlestick: "Candlestick chart",
  asks: "Sell orders",
  bids: "Buy orders",
  owned: "Units owned",
  totalAssets: "Total asset value",
  networkFee: "Network fee",
  status: "Status",
  confirmed: "Confirmed",
  preferences: "Preferences",
  notifications: "Notifications",
  changeLanguage: "Change the entire interface language",
  identity: "Identity verification",
  verifiedDate: "Verification date",
  level: "Level",
  price: "Price alerts",
  dividend: "Dividend alerts",
  listings: "New listing alerts",
  receiveAlerts: "Receive account and asset notifications",
  investor: "Investor",
  subscribeEyebrow: "Primary offering",
  subscribeTitle: "Subscribe",
  subscribeDescription:
    "Assets that have not yet entered the secondary market.",
  subscribing: "Open",
  soldOut: "Sold out",
  ended: "Ended",
  subscriptionUnitPrice: "Subscription unit price",
  subscribeNow: "Subscribe now",
  unavailableSubscribe: "Currently unavailable",
  noSubscriptions:
    "There are currently no pre-secondary-market assets to display.",
  availableBalance: "Available balance",
  subscriptionUnits: "Subscription units",
  subscriptionTotal: "Subscription total",
  confirmSubscription: "Confirm subscription",
};
const simplified = (value: string) =>
  [
    ["臺", "台"],
    ["買入", "买入"],
    ["賣出", "卖出"],
    ["額", "额"],
    ["項目", "项目"],
    ["資產", "资产"],
    ["驗證", "验证"],
    ["歷史", "历史"],
    ["價", "价"],
    ["優勢", "优势"],
    ["網路", "网络"],
    ["確認", "确认"],
    ["設定", "设置"],
    ["鏈", "链"],
    ["實", "实"],
    ["總", "总"],
    ["與", "与"],
    ["為", "为"],
    ["會", "会"],
    ["發", "发"],
    ["區", "区"],
    ["國", "国"],
    ["長", "长"],
    ["間", "间"],
    ["樓", "楼"],
    ["觀", "观"],
    ["辦", "办"],
    ["處", "处"],
  ].reduce((text, [from, to]) => text.split(from).join(to), value);
const simpleExtra: Partial<Record<Lang, Record<string, string>>> = {
  "zh-CN": Object.fromEntries(
    Object.entries(extraZh).map(([k, v]) => [k, simplified(v)]),
  ),
  ja: {
    more: "その他の資産",
    announcement:
      "すべての取引はUSDTで決済されます。購入手数料は無料、売却手数料は総額の1% + 1 USDTです。現在は完全なフロントエンドシミュレーションです。",
    valuation: "資産評価額",
    expectedApy: "予想APY",
    verification: "資産検証",
    fullAddress: "完全な住所",
    propertyHistory: "物件履歴",
    nearbyPricing: "周辺価格",
    advantages: "投資メリット",
    all: "すべて",
    rising: "上昇",
    falling: "下落",
    available: "購入可能",
    backMarket: "市場に戻る",
    candlestick: "ローソク足チャート",
    asks: "売り注文",
    bids: "買い注文",
    owned: "保有口数",
    totalAssets: "総資産価値",
    status: "ステータス",
    confirmed: "確認済み",
    preferences: "環境設定",
    notifications: "通知",
    changeLanguage: "インターフェース全体の言語を変更",
    identity: "本人確認",
    receiveAlerts: "アカウントと資産の通知を受信",
    subscribeEyebrow: "プライマリーマーケット",
    subscribeTitle: "申込み",
    subscribeDescription:
      "まだセカンダリーマーケットに移行していない資産です。",
    subscribing: "申込受付中",
    soldOut: "完売",
    ended: "終了",
    subscriptionUnitPrice: "申込単価",
    subscribeNow: "今すぐ申し込む",
    unavailableSubscribe: "現在申込不可",
    noSubscriptions: "現在表示できる申込対象資産はありません。",
    availableBalance: "利用可能残高",
    subscriptionUnits: "申込口数",
    subscriptionTotal: "申込合計",
    confirmSubscription: "申込みを確定",
  },
  ko: {
    more: "더 많은 자산",
    announcement:
      "모든 거래는 USDT로 결제됩니다. 매수 수수료는 없으며 매도 수수료는 총액의 1% + 1 USDT입니다. 현재 완전한 프런트엔드 시뮬레이션입니다.",
    valuation: "총 자산 가치",
    expectedApy: "예상 APY",
    verification: "자산 검증",
    fullAddress: "전체 주소",
    propertyHistory: "부동산 이력",
    nearbyPricing: "주변 가격",
    advantages: "투자 장점",
    all: "전체",
    rising: "상승",
    falling: "하락",
    available: "구매 가능",
    backMarket: "시장으로 돌아가기",
    candlestick: "캔들 차트",
    asks: "매도 주문",
    bids: "매수 주문",
    owned: "보유 수량",
    totalAssets: "총 자산 가치",
    status: "상태",
    confirmed: "확인됨",
    preferences: "환경설정",
    notifications: "알림",
    changeLanguage: "전체 인터페이스 언어 변경",
    identity: "신원 인증",
    receiveAlerts: "계정 및 자산 알림 수신",
    subscribeEyebrow: "프라이머리 마켓",
    subscribeTitle: "청약",
    subscribeDescription: "아직 세컨더리 마켓에 진입하지 않은 자산입니다.",
    subscribing: "청약 중",
    soldOut: "매진",
    ended: "종료",
    subscriptionUnitPrice: "청약 단가",
    subscribeNow: "지금 청약하기",
    unavailableSubscribe: "현재 청약 불가",
    noSubscriptions: "현재 표시할 수 있는 청약 자산이 없습니다.",
    availableBalance: "사용 가능 잔액",
    subscriptionUnits: "청약 수량",
    subscriptionTotal: "청약 총액",
    confirmSubscription: "청약 확인",
  },
};
const extraKeys = [
  "preferences",
  "notifications",
  "changeLanguage",
  "identity",
  "verifiedDate",
  "level",
  "price",
  "dividend",
  "listings",
  "receiveAlerts",
  "investor",
  "totalAssets",
  "networkFee",
  "status",
  "confirmed",
  "available",
  "quantity",
  "date",
  "transactionHash",
  "depositTitle",
  "withdrawTitle",
  "amount",
  "submit",
  "copyAddress",
] as const;
const extraRows: Record<Lang, string[]> = {
  "zh-TW": [
    "偏好設定",
    "通知",
    "變更整個介面語言",
    "身分驗證",
    "驗證日期",
    "等級",
    "價格通知",
    "收益分配通知",
    "新項目通知",
    "接收帳戶與資產通知",
    "投資者",
    "總資產價值",
    "網路手續費",
    "狀態",
    "已確認",
    "可用",
    "數量",
    "日期",
    "交易雜湊",
    "充值 USDT",
    "提領 USDT",
    "金額",
    "提交",
    "複製地址",
  ],
  "zh-CN": [
    "偏好设置",
    "通知",
    "更改整个界面语言",
    "身份验证",
    "验证日期",
    "等级",
    "价格通知",
    "收益分配通知",
    "新项目通知",
    "接收账户与资产通知",
    "投资者",
    "总资产价值",
    "网络手续费",
    "状态",
    "已确认",
    "可用",
    "数量",
    "日期",
    "交易哈希",
    "充值 USDT",
    "提现 USDT",
    "金额",
    "提交",
    "复制地址",
  ],
  en: [
    "Preferences",
    "Notifications",
    "Change the entire interface language",
    "Identity verification",
    "Verification date",
    "Level",
    "Price alerts",
    "Dividend alerts",
    "New listing alerts",
    "Receive account and asset notifications",
    "Investor",
    "Total asset value",
    "Network fee",
    "Status",
    "Confirmed",
    "Available",
    "Quantity",
    "Date",
    "Transaction hash",
    "Deposit USDT",
    "Withdraw USDT",
    "Amount",
    "Submit",
    "Copy address",
  ],
  ja: [
    "環境設定",
    "通知",
    "インターフェース全体の言語を変更",
    "本人確認",
    "確認日",
    "レベル",
    "価格通知",
    "配当通知",
    "新規上場通知",
    "口座と資産の通知を受信",
    "投資家",
    "総資産価値",
    "ネットワーク手数料",
    "状態",
    "確認済み",
    "利用可能",
    "数量",
    "日付",
    "取引ハッシュ",
    "USDTを入金",
    "USDTを出金",
    "金額",
    "送�����",
    "アドレスをコピー",
  ],
  ko: [
    "환경설정",
    "알림",
    "전체 인터페이스 언어 변경",
    "신원 인증",
    "인증 날짜",
    "등급",
    "가��� 알림",
    "수익 배분 알림",
    "신규 자산 알림",
    "계정 및 자산 알림 수신",
    "투자자",
    "총 자산 가치",
    "네트워크 수수료",
    "상태",
    "확인됨",
    "사용 가능",
    "수량",
    "날짜",
    "거래 해시",
    "USDT 입금",
    "USDT 출금",
    "금액",
    "제출",
    "주소 복사",
  ],
  th: [
    "การตั้งค่า",
    "การแจ้งเตือน",
    "เปลี่ยนภาษาของอินเทอร์เฟซทั้งหมด",
    "การยืนยันตัวตน",
    "วันที่ยืนยัน",
    "ระดับ",
    "แจ้งเตือนราคา",
    "แจ้งเตือนเงินปันผล",
    "แจ้งเตือนรายการใหม่",
    "รับการแจ้งเตือนบัญชีและสินทรัพย์",
    "นักลงทุน",
    "มูลค่าสินทรัพย์รวม",
    "ค่าธรรมเนียมเครือข่าย",
    "สถานะ",
    "ยืนยันแล้ว",
    "พร้อมใช้",
    "จำนวน",
    "วันที่",
    "แฮชธุรกรรม",
    "ฝาก USDT",
    "ถอน USDT",
    "จำนวนเงิน",
    "ส่ง",
    "คัดลอกที่อยู่",
  ],
  vi: [
    "Tùy chọn",
    "Thông báo",
    "Thay đổi ngôn ngữ toàn bộ giao diện",
    "Xác minh danh tính",
    "Ngày xác minh",
    "Cấp độ",
    "Cảnh báo giá",
    "Cảnh báo lợi nhuận",
    "Cảnh báo niêm yết mới",
    "Nhận thông báo tài khoản và tài sản",
    "Nhà đầu tư",
    "Tổng giá trị tài sản",
    "Phí mạng",
    "Trạng thái",
    "Đã xác nhận",
    "Khả dụng",
    "Số lượng",
    "Ngày",
    "Mã giao dịch",
    "Nạp USDT",
    "Rút USDT",
    "Số tiền",
    "Gửi",
    "Sao chép địa chỉ",
  ],
  id: [
    "Preferensi",
    "Notifikasi",
    "Ubah bahasa seluruh antarmuka",
    "Verifikasi identitas",
    "Tanggal verifikasi",
    "Tingkat",
    "Peringatan harga",
    "Peringatan dividen",
    "Peringatan listing baru",
    "Terima notifikasi akun dan aset",
    "Investor",
    "Total nilai aset",
    "Biaya jaringan",
    "Status",
    "Dikonfirmasi",
    "Tersedia",
    "Jumlah",
    "Tanggal",
    "Hash transaksi",
    "Setor USDT",
    "Tarik USDT",
    "Jumlah",
    "Kirim",
    "Salin alamat",
  ],
  ms: [
    "Keutamaan",
    "Pemberitahuan",
    "Tukar bahasa seluruh antara muka",
    "Pengesahan identiti",
    "Tarikh pengesahan",
    "Tahap",
    "Makluman harga",
    "Makluman dividen",
    "Makluman penyenaraian baharu",
    "Terima pemberitahuan akaun dan aset",
    "Pelabur",
    "Jumlah nilai aset",
    "Yuran rangkaian",
    "Status",
    "Disahkan",
    "Tersedia",
    "Kuantiti",
    "Tarikh",
    "Hash transaksi",
    "Deposit USDT",
    "Keluarkan USDT",
    "Jumlah",
    "Hantar",
    "Salin alamat",
  ],
  es: [
    "Preferencias",
    "Notificaciones",
    "Cambiar el idioma de toda la interfaz",
    "Verificación de identidad",
    "Fecha de verificación",
    "Nivel",
    "Alertas de precio",
    "Alertas de dividendos",
    "Alertas de nuevos activos",
    "Recibir avisos de cuenta y activos",
    "Inversor",
    "Valor total de activos",
    "Comisión de red",
    "Estado",
    "Confirmado",
    "Disponible",
    "Cantidad",
    "Fecha",
    "Hash de transacción",
    "Depositar USDT",
    "Retirar USDT",
    "Importe",
    "Enviar",
    "Copiar dirección",
  ],
  fr: [
    "Préférences",
    "Notifications",
    "Changer la langue de toute l’interface",
    "Vérification d’identité",
    "Date de vérification",
    "Niveau",
    "Alertes de prix",
    "Alertes de dividendes",
    "Alertes de nouvelles cotations",
    "Recevoir les notifications du compte et des actifs",
    "Investisseur",
    "Valeur totale des actifs",
    "Frais réseau",
    "Statut",
    "Confirmé",
    "Disponible",
    "Quantité",
    "Date",
    "Hachage de transaction",
    "Déposer des USDT",
    "Retirer des USDT",
    "Montant",
    "Envoyer",
    "Copier l’adresse",
  ],
  de: [
    "Präferenzen",
    "Benachrichtigungen",
    "Sprache der gesamten Oberfläche ändern",
    "Identitätsprüfung",
    "Prüfdatum",
    "Stufe",
    "Preisalarme",
    "Ausschüttungsalarme",
    "Alarme für neue Angebote",
    "Konto- und Asset-Benachrichtigungen erhalten",
    "Investor",
    "Gesamtwert der Assets",
    "Netzwerkgebühr",
    "Status",
    "Bestätigt",
    "Verfügbar",
    "Menge",
    "Datum",
    "Transaktions-Hash",
    "USDT einzahlen",
    "USDT auszahlen",
    "Betrag",
    "Senden",
    "Adresse kopieren",
  ],
  pt: [
    "Preferências",
    "Notificações",
    "Alterar o idioma de toda a interface",
    "Verificação de identidade",
    "Data de verificação",
    "Nível",
    "Alertas de preço",
    "Alertas de dividendos",
    "Alertas de novas listagens",
    "Receber notificações da conta e dos ativos",
    "Investidor",
    "Valor total dos ativos",
    "Taxa de rede",
    "Estado",
    "Confirmado",
    "Disponível",
    "Quantidade",
    "Data",
    "Hash da transação",
    "Depositar USDT",
    "Retirar USDT",
    "Montante",
    "Enviar",
    "Copiar endereço",
  ],
  ru: [
    "Предпочтения",
    "Уведомления",
    "Изменить язык всего интерфейса",
    "Проверка личности",
    "Дата проверки",
    "Уровень",
    "Оповещения о цене",
    "Оповещения о выплатах",
    "Оповещения о новых активах",
    "Получать уведомления об аккаунте и активах",
    "Инвестор",
    "Общая стоимость активов",
    "Сетевая комиссия",
    "Статус",
    "Подтверждено",
    "Доступно",
    "Количество",
    "Дата",
    "Хэш транзакции",
    "Пополнить USDT",
    "Вывести USDT",
    "Сумма",
    "Отправить",
    "Копировать адрес",
  ],
  ar: [
    "التفضيلات",
    "الإشعارات",
    "تغيير لغة الواجهة بالكامل",
    "التحقق من الهوية",
    "تاريخ التحقق",
    "المستوى",
    "تنبيهات الأسعار",
    "تنبيهات الأرباح",
    "تنبيهات الإدراج الجديد",
    "تلقي إشعارات الحساب والأصول",
    "مستثمر",
    "إجمالي قيمة الأصول",
    "رسوم الشبكة",
    "الحالة",
    "مؤكد",
    "متاح",
    "الكمية",
    "التاريخ",
    "معرّف المعاملة",
    "إيداع USDT",
    "سحب USDT",
    "المبلغ",
    "إرسال",
    "نسخ العنوان",
  ],
  hi: [
    "प्राथमिकताएँ",
    "सूचनाएँ",
    "पूरे इंटरफ़ेस की भाषा बदलें",
    "पहचान सत्यापन",
    "सत्यापन तिथि",
    "स्तर",
    "मूल्य सूचन���एँ",
    "लाभांश सूचनाएँ",
    "नई लिस्टिंग सूचनाएँ",
    "खाता और एसेट सूचनाएँ प्राप्त करें",
    "निवेशक",
    "कुल एसेट मूल्य",
    "नेटवर्क शुल्क",
    "स्थिति",
    "पुष्टि हुई",
    "उपलब्ध",
    "मात्रा",
    "तिथि",
    "लेनदेन हैश",
    "USDT जमा करें",
    "USDT निकालें",
    "राशि",
    "जमा करें",
    "पता कॉपी करें",
  ],
};
const LanguageContext = createContext<{
  language: Lang;
  setLanguage: (l: Lang) => void;
  t: (k: Key) => string;
  tr: (k: string) => string;
  assets: Asset[];
} | null>(null);
const assetNames: Record<Lang, string[]> = {
  "zh-TW": ASSETS.map((a) => a.name),
  "zh-CN": [
    "墨尔本 Southbank 河景公寓",
    "东京涩谷商业大楼",
    "新加坡 Marina Bay 景观住宅",
    "伦敦 Canary Wharf 办公室",
  ],
  en: [
    "Melbourne Southbank River View Residence",
    "Tokyo Shibuya Commercial Building",
    "Singapore Marina Bay Residence",
    "London Canary Wharf Office",
  ],
  ja: [
    "メルボルン・サウスバンク リバービュー住宅",
    "東京渋谷 商業ビル",
    "シンガポール・マリーナベイ眺望住宅",
    "ロンドン・カナリーワーフ オフィス",
  ],
  ko: [
    "멜버른 사우스뱅크 리버뷰 주거",
    "도쿄 시부야 상업 빌딩",
    "싱가포르 마리나베이 전망 주거",
    "런던 카나리워프 오피스",
  ],
  th: [
    "ที่พักวิวแม่น้ำเมลเบิร์นเซาท์แบงก์",
    "อาคารพาณิชย์โตเกียวชิบูย่า",
    "ที่พักวิวมารีนาเบย์สิงคโปร์",
    "สำนักงานลอนดอนคานารีวอร์ฟ",
  ],
  vi: [
    "Căn hộ hướng sông Melbourne Southbank",
    "Tòa nhà thương mại Tokyo Shibuya",
    "Căn hộ Marina Bay Singapore",
    "Văn phòng London Canary Wharf",
  ],
  id: [
    "Hunian Pemandangan Sungai Melbourne Southbank",
    "Gedung Komersial Tokyo Shibuya",
    "Hunian Marina Bay Singapura",
    "Kantor London Canary Wharf",
  ],
  ms: [
    "Kediaman Pemandangan Sungai Melbourne Southbank",
    "Bangunan Komersial Tokyo Shibuya",
    "Kediaman Marina Bay Singapura",
    "Pejabat London Canary Wharf",
  ],
  es: [
    "Residencia con vistas al río Melbourne Southbank",
    "Edificio comercial Tokyo Shibuya",
    "Residencia Marina Bay Singapur",
    "Oficina London Canary Wharf",
  ],
  fr: [
    "Résidence avec vue sur la rivière Melbourne Southbank",
    "Immeuble commercial Tokyo Shibuya",
    "Résidence Marina Bay Singapour",
    "Bureaux London Canary Wharf",
  ],
  de: [
    "Melbourne Southbank Residenz mit Flussblick",
    "Geschäftshaus Tokyo Shibuya",
    "Singapore Marina Bay Residenz",
    "London Canary Wharf Büro",
  ],
  pt: [
    "Residência com vista para o rio Melbourne Southbank",
    "Edifício comercial Tokyo Shibuya",
    "Residência Marina Bay Singapura",
    "Escritório London Canary Wharf",
  ],
  ru: [
    "Резиденция Melbourne Southbank с видом на реку",
    "Коммерческое здание Tokyo Shibuya",
    "Резиден��ия Singapore Marina Bay",
    "Офис London Canary Wharf",
  ],
  ar: [
    "سكن ملبورن ساوث بانك بإطلالة على النهر",
    "مبنى طوكيو شيبويا التجاري",
    "سكن سنغافورة مارينا باي",
    "مكتب لندن كناري وارف",
  ],
  hi: [
    "मेलबर्न साउथबैंक र����वर व्यू निवास",
    "टोक्यो शिबुया वाणिज्यिक भवन",
    "सिंगापुर मरीना बे निवास",
    "लंदन कैनरी व���हार्फ कार्यालय",
  ],
};
const localizeAssets = (language: Lang) =>
  ASSETS.map((a, index) =>
    language === "zh-TW"
      ? a
      : language === "zh-CN"
        ? {
            ...a,
            name: assetNames[language][index],
            history: a.history.map(simplified),
            comparables: a.comparables.map(simplified),
            advantages: a.advantages.map(simplified),
          }
        : {
            ...a,
            name: assetNames[language][index],
            history:
              a.id === "mel-southbank"
                ? [
                    "Completed and licensed in 2018",
                    "Fully renovated in 2022",
                    "Independently valued at 2.5M USDT in 2026",
                  ]
                : [
                    "Completed and fully licensed",
                    "Recent efficiency and interior upgrades",
                    "Independent valuation and on-chain verification completed",
                  ],
            comparables: [
              "Pricing benchmarked against recent nearby transactions",
              "Local vacancy rate remains below the regional average",
              "Rental demand and rates continue to grow",
            ],
            advantages: [
              "Prime location near major transit",
              "Stable occupancy and tenant demand",
              "Independently verified real-world asset",
            ],
          },
  );
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Lang>(() => {
    const q = new URLSearchParams(location.search).get("lang") as Lang;
    return LANGUAGES.some((x) => x[0] === q) ? q : "zh-TW";
  });
  const setLanguage = (l: Lang) => {
    setLanguageState(l);
    const u = new URL(location.href);
    u.searchParams.set("lang", l);
    history.replaceState(null, "", u);
  };
  useEffect(() => {
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = language;
  }, [language]);
  const value = useMemo(
    () => ({
      language,
      setLanguage,
      t: (k: Key) => words[language][keys.indexOf(k)],
      tr: (k: string) => {
        const index = extraKeys.indexOf(k as (typeof extraKeys)[number]);
        return index >= 0
          ? extraRows[language][index]
          : (simpleExtra[language]?.[k] ??
              (language === "zh-TW" ? extraZh[k] : extraEn[k]) ??
              k);
      },
      assets: localizeAssets(language),
    }),
    [language],
  );
  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}
export const useLanguage = () => {
  const v = useContext(LanguageContext);
  if (!v) throw new Error("LanguageProvider missing");
  return v;
};

export type ColorMode = "dark" | "light" | "system";
export type AccentColor = "amber" | "blue" | "emerald" | "violet";
type ThemeValue = {
  mode: ColorMode;
  accent: AccentColor;
  setMode: (mode: ColorMode) => void;
  setAccent: (accent: AccentColor) => void;
};
const ThemeContext = createContext<ThemeValue | null>(null);
const modes: ColorMode[] = ["dark", "light", "system"];
const accents: AccentColor[] = ["amber", "blue", "emerald", "violet"];
export function ThemeProvider({ children }: { children: ReactNode }) {
  const params = new URLSearchParams(location.search);
  const [mode, setModeState] = useState<ColorMode>(() => {
    const value = params.get("theme") as ColorMode;
    return modes.includes(value) ? value : "dark";
  });
  const [accent, setAccentState] = useState<AccentColor>(() => {
    const value = params.get("accent") as AccentColor;
    return accents.includes(value) ? value : "amber";
  });
  const updateUrl = (key: string, value: string) => {
    const url = new URL(location.href);
    url.searchParams.set(key, value);
    history.replaceState(null, "", url);
  };
  const setMode = (value: ColorMode) => {
    setModeState(value);
    updateUrl("theme", value);
  };
  const setAccent = (value: AccentColor) => {
    setAccentState(value);
    updateUrl("accent", value);
  };
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.accent = accent;
      document.documentElement.style.colorScheme =
        mode === "system" ? "light dark" : mode;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode, accent]);
  return (
    <ThemeContext.Provider value={{ mode, accent, setMode, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider missing");
  return value;
};
export const formatUSDT = (n: number) =>
  `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
