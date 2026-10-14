// Supabase/PostgREST silently caps a single response at 1000 rows. Any
// dashboard that sums a whole table must page through it, otherwise older rows
// are dropped without an error and the totals come out wrong.
export const SUPABASE_PAGE_SIZE = 1000;
const MAX_PAGES = 200;

type PageResult<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

export async function fetchAllRows<T>(
  buildPage: (from: number, to: number) => PageResult<T>,
  pageSize = SUPABASE_PAGE_SIZE,
): Promise<{ data: T[] | null; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * pageSize;
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return { data: rows, error: null };
  }
  return {
    data: null,
    error: { message: "資料筆數超過讀取上限，無法完整載入" },
  };
}
