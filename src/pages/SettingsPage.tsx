import { useState, useMemo, useRef, useEffect } from 'react';
import { Globe, Bell, Shield, Coins, CheckCircle2, Search, Check, X, ChevronRight } from 'lucide-react';

type Language = {
  code: string;
  name: string;
  native: string;
  flag: string;
};

const LANGUAGES: Language[] = [
  { code: 'zh-TW', name: '繁體中文', native: '繁體中文', flag: '🇹🇼' },
  { code: 'zh-CN', name: '簡體中文', native: '简体中文', flag: '🇨🇳' },
  { code: 'en', name: '英文', native: 'English', flag: '🇬🇧' },
  { code: 'ja', name: '日文', native: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: '韓文', native: '한국어', flag: '🇰🇷' },
  { code: 'th', name: '泰文', native: 'ไทย', flag: '🇹🇭' },
  { code: 'vi', name: '越南文', native: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'id', name: '印尼文', native: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ms', name: '馬來文', native: 'Bahasa Melayu', flag: '🇲🇾' },
  { code: 'es', name: '西班牙文', native: 'Español', flag: '🇪🇸' },
  { code: 'fr', name: '法文', native: 'Français', flag: '🇫🇷' },
  { code: 'de', name: '德文', native: 'Deutsch', flag: '🇩🇪' },
  { code: 'pt', name: '葡萄牙文', native: 'Português', flag: '🇵🇹' },
  { code: 'ru', name: '俄文', native: 'Русский', flag: '🇷🇺' },
  { code: 'ar', name: '阿拉伯文', native: 'العربية', flag: '🇸🇦' },
  { code: 'hi', name: '印地文', native: 'हिन्दी', flag: '🇮🇳' },
];

export function SettingsPage() {
  const [currency, setCurrency] = useState('USDC');
  const [language, setLanguage] = useState<Language>(LANGUAGES[0]);
  const [langModalOpen, setLangModalOpen] = useState(false);
  const [notifications, setNotifications] = useState({
    priceAlerts: true,
    dividendUpdates: true,
    newListings: false,
  });
  const [autoReinvest, setAutoReinvest] = useState(false);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold tracking-tight text-white">設定</h1>
        <p className="mt-1 text-sm text-slate-400">管理你的帳戶偏好與安全設定</p>
      </section>

      {/* Preferences */}
      <SettingsGroup title="偏好設定" icon={<Globe className="h-5 w-5" />}>
        <SelectRow
          label="顯示貨幣"
          value={currency}
          options={['USDC', 'USD', 'AUD', 'SGD']}
          onChange={setCurrency}
        />
        <LanguageRow language={language} onClick={() => setLangModalOpen(true)} />
      </SettingsGroup>

      {/* Notifications */}
      <SettingsGroup title="通知" icon={<Bell className="h-5 w-5" />}>
        <ToggleRow
          label="價格提醒"
          description="當持有的資產價格變動超過 5% 時通知"
          value={notifications.priceAlerts}
          onToggle={() => setNotifications((n) => ({ ...n, priceAlerts: !n.priceAlerts }))}
        />
        <ToggleRow
          label="收益分配通知"
          description="收到租金收益分配時通知"
          value={notifications.dividendUpdates}
          onToggle={() => setNotifications((n) => ({ ...n, dividendUpdates: !n.dividendUpdates }))}
        />
        <ToggleRow
          label="新項目上架"
          description="有新資產代幣化時通知"
          value={notifications.newListings}
          onToggle={() => setNotifications((n) => ({ ...n, newListings: !n.newListings }))}
        />
      </SettingsGroup>

      {/* Investment */}
      <SettingsGroup title="投資設定" icon={<Coins className="h-5 w-5" />}>
        <ToggleRow
          label="自動再投資"
          description="將收益分配自動再投資到相同資產"
          value={autoReinvest}
          onToggle={() => setAutoReinvest(!autoReinvest)}
        />
      </SettingsGroup>

      {/* Security */}
      <SettingsGroup title="安全" icon={<Shield className="h-5 w-5" />}>
        <InfoRow label="錢包連接" value="MetaMask" status="已連接" />
        <InfoRow label="兩步驟驗證" value="" status="已啟用" />
        <InfoRow label="帳戶驗證 (KYC)" value="" status="已完成" />
      </SettingsGroup>

      <div className="pb-4 text-center text-xs text-slate-500">
        RWA 資產代幣化平台 ・ 版本 1.0.0
      </div>

      {langModalOpen && (
        <LanguagePickerModal
          current={language}
          onClose={() => setLangModalOpen(false)}
          onSelect={(lang) => {
            setLanguage(lang);
            setLangModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function LanguageRow({ language, onClick }: { language: Language; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-slate-800/30">
      <div>
        <p className="text-sm font-medium text-white">語言</p>
        <p className="mt-0.5 text-xs text-slate-400">介面顯示語言</p>
      </div>
      <div className="flex items-center gap-2 text-sm text-slate-300">
        <span className="text-base">{language.flag}</span>
        <span>{language.native}</span>
        <ChevronRight className="h-4 w-4 text-slate-500" />
      </div>
    </button>
  );
}

function LanguagePickerModal({
  current,
  onClose,
  onSelect,
}: {
  current: Language;
  onClose: () => void;
  onSelect: (lang: Language) => void;
}) {
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return LANGUAGES;
    return LANGUAGES.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.native.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-t-3xl border border-slate-700/50 bg-slate-900 shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-700/50 px-5 py-4">
          <h3 className="text-base font-semibold text-white">選擇語言</h3>
          <button onClick={onClose} className="text-slate-400 transition-colors hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-slate-700/50 p-4">
          <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2.5 focus-within:border-amber-500">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋語言..."
              className="w-full bg-transparent text-sm text-white placeholder:text-slate-500 outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-slate-400 transition-colors hover:text-white">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">找不到符合的語言</p>
          ) : (
            <ul className="space-y-1">
              {filtered.map((lang) => {
                const active = lang.code === current.code;
                return (
                  <li key={lang.code}>
                    <button
                      onClick={() => onSelect(lang)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                        active ? 'bg-amber-500/10 ring-1 ring-amber-500/20' : 'hover:bg-slate-800/60'
                      }`}
                    >
                      <span className="text-xl">{lang.flag}</span>
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${active ? 'text-amber-300' : 'text-white'}`}>{lang.native}</p>
                        <p className="text-xs text-slate-400">{lang.name}</p>
                      </div>
                      {active && <Check className="h-4 w-4 text-amber-400" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-slate-700/50 px-5 py-3 text-center text-xs text-slate-500">
          共 {LANGUAGES.length} 種語言
        </div>
      </div>
    </div>
  );
}

function SettingsGroup({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-900/40 backdrop-blur-sm">
      <div className="flex items-center gap-2 border-b border-slate-700/50 px-5 py-3.5">
        <span className="text-amber-300">{icon}</span>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
      </div>
      <div className="divide-y divide-slate-800/60">{children}</div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onToggle,
}: {
  label: string;
  description?: string;
  value: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        {description && <p className="mt-0.5 text-xs text-slate-400">{description}</p>}
      </div>
      <button
        onClick={onToggle}
        className={`relative h-6 w-11 rounded-full transition-colors ${value ? 'bg-amber-500' : 'bg-slate-700'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <p className="text-sm font-medium text-white">{label}</p>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 outline-none transition-colors focus:border-amber-500"
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

function InfoRow({ label, value, status }: { label: string; value: string; status: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <p className="text-sm font-medium text-white">{label}</p>
      <div className="flex items-center gap-2">
        {value && <span className="text-xs text-slate-400">{value}</span>}
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {status}
        </span>
      </div>
    </div>
  );
}
