import { describe, expect, it } from "vitest";
import { nextEscrowMatch, type MatchableEscrowOrder } from "../api/_escrowMatching";

const ASSET = "0x1111111111111111111111111111111111111111";
const JC = "0x2222222222222222222222222222222222222222";
const wad = 10n ** 18n;

function order(input: Partial<MatchableEscrowOrder> & Pick<MatchableEscrowOrder, "id" | "user_id" | "side" | "price" | "escrow_chain_order_id">): MatchableEscrowOrder {
  return {
    remaining_quantity: "2",
    escrow_token_address: ASSET,
    escrow_currency_address: JC,
    ...input,
  };
}

describe("automatic escrow match selection", () => {
  it("matches the best ask against the best eligible bid by price then chain time", () => {
    const sellBest = order({ id: "sell-best", user_id: "seller-a", side: "sell", price: "8", escrow_chain_order_id: "50" });
    const sellLater = order({ id: "sell-later", user_id: "seller-b", side: "sell", price: "8", escrow_chain_order_id: "51" });
    const buySelf = order({ id: "buy-self", user_id: "seller-a", side: "buy", price: "12", escrow_chain_order_id: "10" });
    const buyBest = order({ id: "buy-best", user_id: "buyer-a", side: "buy", price: "11", escrow_chain_order_id: "20" });
    const buyLater = order({ id: "buy-later", user_id: "buyer-b", side: "buy", price: "11", escrow_chain_order_id: "21" });

    const match = nextEscrowMatch([sellLater, buyLater, sellBest, buySelf, buyBest], ASSET, JC);

    expect(match).toEqual({ buy: buyBest, sell: sellBest, quantity: 2n * wad, executionPrice: 11n * wad });
  });

  it("uses the earlier resting order price and caps a fill to the smaller remainder", () => {
    const olderBuy = order({ id: "buy", user_id: "buyer", side: "buy", price: "12", remaining_quantity: "3", escrow_chain_order_id: "10" });
    const newerSell = order({ id: "sell", user_id: "seller", side: "sell", price: "10", remaining_quantity: "1.5", escrow_chain_order_id: "20" });

    const match = nextEscrowMatch([newerSell, olderBuy], ASSET, JC);

    expect(match?.executionPrice).toBe(12n * wad);
    expect(match?.quantity).toBe(15n * 10n ** 17n);
  });

  it("does not cross prices, tokens, or counterparties owned by the same user", () => {
    const sell = order({ id: "sell", user_id: "same-user", side: "sell", price: "9", escrow_chain_order_id: "2" });
    const ownBuy = order({ id: "own-buy", user_id: "same-user", side: "buy", price: "10", escrow_chain_order_id: "1" });
    const lowBuy = order({ id: "low-buy", user_id: "other-user", side: "buy", price: "8", escrow_chain_order_id: "3" });

    expect(nextEscrowMatch([sell, ownBuy], ASSET, JC)).toBeNull();
    expect(nextEscrowMatch([sell, lowBuy], ASSET, JC)).toBeNull();
    expect(nextEscrowMatch([sell, { ...lowBuy, price: "10", escrow_currency_address: ASSET }], ASSET, JC)).toBeNull();
  });

  it("skips fills below the contract's minimum gross amount", () => {
    const sell = order({ id: "sell", user_id: "seller", side: "sell", price: "1", remaining_quantity: "2", escrow_chain_order_id: "2" });
    const smallBuy = order({ id: "small-buy", user_id: "buyer-a", side: "buy", price: "2", remaining_quantity: "0.5", escrow_chain_order_id: "1" });
    const largeBuy = order({ id: "large-buy", user_id: "buyer-b", side: "buy", price: "2", remaining_quantity: "2", escrow_chain_order_id: "3" });

    const match = nextEscrowMatch([sell, smallBuy, largeBuy], ASSET, JC);

    expect(match?.buy.id).toBe("large-buy");
    expect(match?.quantity).toBe(2n * wad);
  });
});
