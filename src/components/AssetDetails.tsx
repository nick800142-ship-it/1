import type { ReactNode } from "react";
import { Building2, CheckCircle2, Clock3, MapPin, TrendingUp } from "lucide-react";
import { AssetImageGallery } from "@/components/AssetImageGallery";
import { formatApy, formatEndsAt, formatUSDT, useLanguage, type Asset } from "@/platform";

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-800/60 p-4">
      <span className="text-amber-300">{icon}</span>
      <p className="mt-3 text-xs text-slate-400">{label}</p>
      <p className="mt-1 font-bold">{value}</p>
    </div>
  );
}

function Info({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded-2xl border border-slate-800 p-4">
      <h3 className="font-semibold text-amber-300">{title}</h3>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-sm text-slate-300">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AssetDetails({ asset, action }: { asset: Asset; action?: ReactNode }) {
  const { tr } = useLanguage();
  return (
    <section aria-label={tr("assetDetails")} className="grid gap-6 md:grid-cols-2">
      <AssetImageGallery images={asset.images?.length ? asset.images : [asset.image]} assetName={asset.name} />
      <div className="flex flex-col gap-4">
        {!asset.isAeToken && (
          <div>
            <p className="text-xs text-slate-500">{tr("fullAddress")}</p>
            <p className="mt-1 flex min-w-0 gap-2 break-words text-sm">
              <MapPin className="size-4 shrink-0 text-amber-400" />
              {asset.address}
            </p>
          </div>
        )}
        {!asset.isAeToken && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Metric icon={<TrendingUp />} label="APY" value={formatApy(asset.apy)} />
            <Metric icon={<Building2 />} label="總發行量" value={asset.total.toLocaleString()} />
            <Metric icon={<Building2 />} label="剩餘發行量" value={asset.available.toLocaleString()} />
            <div className="sm:col-span-2">
              <Metric
                icon={<Clock3 />}
                label="私募結束時間"
                value={formatEndsAt(asset.endsAt, (date) =>
                  new Intl.DateTimeFormat("zh-TW", {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  }).format(date),
                )}
              />
            </div>
            <div className="sm:col-span-2">
              <Metric icon={<Building2 />} label={tr("valuation")} value={formatUSDT(asset.valuation)} />
            </div>
          </div>
        )}
      </div>
      {asset.information && (
        <div className="rounded-2xl border border-slate-800 p-4 md:col-span-2">
          <h3 className="font-semibold text-amber-300">資產介紹</h3>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{asset.information}</p>
        </div>
      )}
      {asset.history.length > 0 && <Info title={tr("propertyHistory")} items={asset.history} />}
      {asset.comparables.length > 0 && <Info title={tr("nearbyPricing")} items={asset.comparables} />}
      {asset.advantages.length > 0 && (
        <div className="md:col-span-2"><Info title={tr("advantages")} items={asset.advantages} /></div>
      )}
      {action && <div className="md:col-span-2">{action}</div>}
    </section>
  );
}
