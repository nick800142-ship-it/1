import { parseUnits } from "viem";

export type MatchableEscrowOrder = {
  id: string;
  user_id: string;
  side: "buy" | "sell";
  price: number | string;
  remaining_quantity: number | string;
  escrow_chain_order_id: number | string;
  escrow_token_address: string | null;
  escrow_currency_address: string | null;
};

export type EscrowMatchCandidate = {
  buy: MatchableEscrowOrder;
  sell: MatchableEscrowOrder;
  quantity: bigint;
  executionPrice: bigint;
};

export function orderUnits(value: number | string): bigint {
  return parseUnits(String(value), 18);
}

export function roundedEscrowGross(price: bigint, quantity: bigint): bigint {
  const raw = (price * quantity) / 10n ** 18n;
  return ((raw + 500_000_000_000n) / 1_000_000_000_000n) * 1_000_000_000_000n;
}

export function nextEscrowMatch(
  orders: MatchableEscrowOrder[],
  assetToken: string,
  currencyToken: string,
): EscrowMatchCandidate | null {
  const compatible = orders.filter((order) =>
    order.escrow_chain_order_id != null &&
    order.escrow_token_address?.toLowerCase() === assetToken.toLowerCase() &&
    order.escrow_currency_address?.toLowerCase() === currencyToken.toLowerCase(),
  );
  const chainId = (order: MatchableEscrowOrder) => BigInt(order.escrow_chain_order_id);
  const sells = compatible.filter((order) => order.side === "sell").sort((a, b) => {
    const priceDifference = orderUnits(a.price) - orderUnits(b.price);
    return priceDifference < 0n ? -1 : priceDifference > 0n ? 1 : chainId(a) < chainId(b) ? -1 : chainId(a) > chainId(b) ? 1 : 0;
  });
  const buys = compatible.filter((order) => order.side === "buy").sort((a, b) => {
    const priceDifference = orderUnits(b.price) - orderUnits(a.price);
    return priceDifference < 0n ? -1 : priceDifference > 0n ? 1 : chainId(a) < chainId(b) ? -1 : chainId(a) > chainId(b) ? 1 : 0;
  });

  for (const sell of sells) {
    const sellPrice = orderUnits(sell.price);
    for (const buy of buys) {
      const buyPrice = orderUnits(buy.price);
      if (buyPrice < sellPrice) break;
      if (buy.user_id === sell.user_id) continue;
      const sellQuantity = orderUnits(sell.remaining_quantity);
      const buyQuantity = orderUnits(buy.remaining_quantity);
      const quantity = sellQuantity < buyQuantity ? sellQuantity : buyQuantity;
      const executionPrice = chainId(buy) < chainId(sell) ? buyPrice : sellPrice;
      if (roundedEscrowGross(executionPrice, quantity) < 2n * 10n ** 18n) continue;
      return { buy, sell, quantity, executionPrice };
    }
  }
  return null;
}
