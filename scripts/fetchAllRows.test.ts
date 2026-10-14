import { describe, expect, it } from "vitest";
import { fetchAllRows } from "../src/lib/fetchAllRows";

const makeSource = (total: number) => {
  const all = Array.from({ length: total }, (_, index) => ({ id: index }));
  return async (from: number, to: number) => ({
    data: all.slice(from, to + 1),
    error: null,
  });
};

describe("fetchAllRows", () => {
  it("reads every row when the table is larger than one page", async () => {
    const result = await fetchAllRows(makeSource(2631), 1000);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(2631);
  });

  it("handles an exact multiple of the page size", async () => {
    const result = await fetchAllRows(makeSource(2000), 1000);
    expect(result.data).toHaveLength(2000);
  });

  it("handles an empty table", async () => {
    const result = await fetchAllRows(makeSource(0), 1000);
    expect(result.data).toEqual([]);
  });

  it("returns the error instead of partial data", async () => {
    const result = await fetchAllRows(async (from) =>
      from === 0
        ? { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null }
        : { data: null, error: { message: "boom" } },
    );
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe("boom");
  });
});
