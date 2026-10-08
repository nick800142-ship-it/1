import { describe, expect, it } from "vitest";
import { resolveAnnouncementDestination } from "../src/lib/announcementRouting";

describe("announcement destination detection", () => {
  it.each([
    ["zh-TW", "二級市場交易更新", "market"],
    ["en", "Secondary market trading is open", "market"],
    ["ja", "二次流通の取引を開始しました", "market"],
    ["ko", "2차 시장 거래 안내", "market"],
    ["vi", "Thị trường thứ cấp đã mở", "market"],
    ["id", "Pasar sekunder sudah dibuka", "market"],
    ["es", "Mercado secundario disponible", "market"],
    ["ru", "Открыт вторичный рынок", "market"],
  ])("routes a %s announcement to its page", (_language, content, page) => {
    expect(resolveAnnouncementDestination({ title: "Update", content })).toEqual({ page });
  });

  it("detects intent from another available translation when the active language has no translation", () => {
    expect(
      resolveAnnouncementDestination({
        title: "平台更新",
        content: "功能現已開放",
        translations: {
          en: { title: "Wallet notice", content: "USDT withdrawals are available" },
          "zh-TW": { title: "錢包公告", content: "USDT 提領功能已開放" },
        },
      }),
    ).toEqual({ page: "wallet" });
  });

  it("routes an asset announcement to the specific subscription asset", () => {
    expect(
      resolveAnnouncementDestination(
        { title: "New offering", content: "Melbourne Southbank is open for subscription" },
        [
          {
            id: "southbank-1",
            name: "墨爾本南岸公寓",
            translations: { en: { name: "Melbourne Southbank Residence" } },
          },
        ],
      ),
    ).toEqual({ page: "subscribe", assetId: "southbank-1" });
  });

  it("routes a secondary-market asset announcement directly to its market detail", () => {
    expect(
      resolveAnnouncementDestination(
        { title: "Melbourne Southbank", content: "Secondary market orders are open" },
        [{ id: "southbank-1", name: "Melbourne Southbank", marketStartedAt: "2026-10-01T00:00:00Z" }],
      ),
    ).toEqual({ page: "market", assetId: "southbank-1" });
  });

  it("does not match a short ticker inside unrelated words", () => {
    expect(
      resolveAnnouncementDestination(
        { title: "New market listing", content: "The market is open" },
        [{ id: "ae", name: "AE" }],
      ),
    ).toEqual({ page: "market" });
  });
});
