export type CommissionTypeMeta = {
  label: string;
  badgeClass: string;
};

const COMMISSION_TYPE_META: Record<string, CommissionTypeMeta> = {
  "Self-Rebate-Master": {
    label: "🟢 自購返佣",
    badgeClass: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
  },
  "Self-Rebate-Agent": {
    label: "🟢 自購返佣",
    badgeClass: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
  },
  "Override-Margin": {
    label: "🔵 團隊級差分潤",
    badgeClass: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
  },
  "Master-Margin": {
    label: "🔵 團隊級差分潤",
    badgeClass: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
  },
  "Direct-Agent-Commission": {
    label: "🟠 直屬代理分潤",
    badgeClass: "bg-orange-500/10 text-orange-300 ring-orange-500/20",
  },
  private: {
    label: "私募",
    badgeClass: "bg-amber-500/10 text-amber-300 ring-amber-500/20",
  },
  secondary: {
    label: "二級市場",
    badgeClass: "bg-slate-800 text-slate-300 ring-slate-700",
  },
};

export function getCommissionTypeMeta(type: string): CommissionTypeMeta {
  return (
    COMMISSION_TYPE_META[type] ?? {
      label: type || "其他分潤",
      badgeClass: "bg-slate-800 text-slate-300 ring-slate-700",
    }
  );
}
