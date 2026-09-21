-- 二級市場營收（平台實收手續費）唯讀彙總 RPC。
-- platform_fee_ledger 開啟了 RLS 但沒有任何 policy，前端以使用者 session 直接 select
-- 會被拒 → 後台報表出現「無法載入系統監控資料」且二級市場營收顯示 0。改用 SECURITY
-- DEFINER 的管理員 RPC 讀取，避免對該表加開放式讀取 policy。
-- 回傳 p2p_fee 手續費列（含成交 1% + 掛賣單一次性 1 JC，含取消掛單仍不退還的預扣
-- 1 JC），交由前端依報表日期範圍過濾與加總。
create or replace function public.admin_secondary_fee_rows()
returns table(id uuid, amount numeric, source_type text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select f.id, f.amount, f.source_type, f.created_at
  from public.platform_fee_ledger f
  where f.source_type = 'p2p_fee'
  order by f.created_at desc;
end;
$function$;

revoke all on function public.admin_secondary_fee_rows() from public;
grant execute on function public.admin_secondary_fee_rows() to authenticated;

-- 舊的單一數字版本若已建立則移除，避免混淆。
drop function if exists public.admin_secondary_fee_revenue(timestamptz, timestamptz);
