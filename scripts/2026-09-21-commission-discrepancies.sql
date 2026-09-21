-- 代理獎金派發錯誤稽核：比對「應派發」與「實際已發放（含沖正）」的差額，找出多發/少發。
--
-- 定義：
--   owed  = 該受益人所有「已標記派發」（commission_logs.paid_at 不為 null）分潤的應發金額總和。
--   paid  = 該受益人 jc_ledger 中 commission_payout（實際派發入帳）＋ commission_reversal（沖正
--           調整，可正可負）的金額總和。
--   diff  = paid - owed。diff > 0 代表「多發」（實際入帳超過應發），diff < 0 代表「少發」。
--
-- 健康狀態下：settleCommissionCore 每派發一筆分潤，就會同時把 commission_logs.paid_at 設值並寫入
-- 等額的 commission_payout，因此 owed == paid、diff == 0，不會出現在稽核清單。尚未派發（pending，
-- paid_at 為 null）的分潤不算「錯誤」，因為 owed 只計已標記派發者，故也不會出現在清單。
-- 只有真正對不上（例如重複入帳、歷史手動調整、部分失敗）才會被列出。
create or replace function public.admin_commission_discrepancies()
returns table(
  beneficiary_id uuid,
  email text,
  nickname text,
  display_name text,
  agency_role text,
  owed numeric,
  paid numeric,
  diff numeric
)
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
  with owed_cte as (
    select c.beneficiary_id as bid, sum(c.commission_amount) as owed
    from public.commission_logs c
    where c.paid_at is not null and c.beneficiary_id is not null
    group by c.beneficiary_id
  ),
  paid_cte as (
    select l.user_id as bid, sum(l.amount) as paid
    from public.jc_ledger l
    where l.entry_type in ('commission_payout', 'commission_reversal')
    group by l.user_id
  ),
  merged as (
    select
      coalesce(o.bid, p.bid) as bid,
      coalesce(o.owed, 0)::numeric as owed,
      coalesce(p.paid, 0)::numeric as paid
    from owed_cte o
    full outer join paid_cte p on p.bid = o.bid
  )
  select
    m.bid,
    pr.email,
    pr.nickname,
    pr.display_name,
    pr.agency_role,
    round(m.owed, 6) as owed,
    round(m.paid, 6) as paid,
    round(m.paid - m.owed, 6) as diff
  from merged m
  join public.profiles pr on pr.id = m.bid
  where abs(m.paid - m.owed) > 0.000001
  order by abs(m.paid - m.owed) desc;
end;
$function$;
