-- 2026-10-19 AE 獎勵結束後套用「平常日價格」(bonus_normal_price)
-- 問題：只有「售罄」時由前端呼叫 relayer 套用價格；時間到自動結束、管理員提前結束都只恢復平常日，
--       價格仍停在舊值（例：設定 3.84，實際恢復成 3.2）。
-- 修正：共用 private.resume_ae_daily_after_bonus，於售罄／手動結束／時間到結束時恢復平常日並套用價格。
--       清倉中的回合（已結束）售罄時不再重套價格，避免覆蓋管理員之後調整過的平常日價格。

create or replace function private.resume_ae_daily_after_bonus(p_bonus_id text, p_apply_price boolean default true)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  normal_price numeric;
begin
  select bonus_normal_price into normal_price
    from public.private_placements
   where id = p_bonus_id and is_ae_token = true and ae_token_kind = 'bonus';

  update public.private_placements
     set is_active = true,
         price = case when p_apply_price and normal_price > 0 then normal_price else price end,
         updated_at = now()
   where id = 'ae-token-daily';

end;
$function$;

revoke all on function private.resume_ae_daily_after_bonus(text, boolean) from public, anon, authenticated;

create or replace function private.expire_ae_bonus_rounds()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  expired_round record;
  expired integer := 0;
begin
  for expired_round in
    update public.private_placements
       set release_frozen_at = ends_at, updated_at = now()
     where is_ae_token = true
       and ae_token_kind = 'bonus'
       and is_active = true
       and release_frozen_at is null
       and ends_at <= clock_timestamp()
    returning id
  loop
    expired := expired + 1;
    perform private.resume_ae_daily_after_bonus(expired_round.id, true);
  end loop;
  return expired;
end;
$function$;

revoke all on function private.expire_ae_bonus_rounds() from public, anon, authenticated;

create or replace function public.admin_end_ae_token_bonus_round(p_asset_id text)
returns public.private_placements
language plpgsql
security definer
set search_path to ''
as $function$
declare
  result public.private_placements;
  admin_email text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  update public.private_placements
  set release_frozen_at=now(), updated_at=now()
  where id=p_asset_id and is_ae_token=true and ae_token_kind='bonus' and is_active=true and release_frozen_at is null
  returning * into result;

  if result.id is null then
    raise exception 'bonus round not found or already ended';
  end if;

  perform private.resume_ae_daily_after_bonus(result.id, true);

  select email into admin_email from auth.users where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),admin_email,'end','ae_token_bonus_round',result.id,
    jsonb_build_object('available_remaining',result.available,'ended_at',result.release_frozen_at,'daily_price',result.bonus_normal_price));

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_private_purchase(p_request_key text, p_jc_pull_tx text, p_jc_vault_tx text, p_asset_tx text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.settlement_reservations; a public.private_placements; ledger_row public.jc_ledger; new_available numeric;
begin
  if coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true)) is distinct from 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  if p_request_key is null or p_jc_pull_tx !~ '^0x[0-9a-fA-F]{64}$' or p_jc_vault_tx !~ '^0x[0-9a-fA-F]{64}$' or p_asset_tx !~ '^0x[0-9a-fA-F]{64}$' then raise exception 'invalid chain transaction data'; end if;
  select * into r from public.settlement_reservations where request_key = p_request_key for update;
  if not found or r.action <> 'subscribe' then raise exception 'subscription reservation not found'; end if;
  if r.status = 'confirmed' then select * into ledger_row from public.jc_ledger where idempotency_key = p_request_key; return jsonb_build_object('status', 'confirmed', 'idempotent', true, 'ledger_id', ledger_row.id); end if;
  if r.status <> 'pending' then raise exception 'subscription reservation is not pending'; end if;
  perform 1 from public.profiles where id = r.user_id for update;
  select * into a from public.private_placements where id = r.asset_id for update;
  if not found then raise exception 'placement not found'; end if;
  if a.available < r.quantity then raise exception 'reserved placement inventory is no longer available'; end if;
  perform set_config('app.settlement_request_key', p_request_key, true);
  insert into public.jc_ledger(user_id, entry_type, amount, asset_id, quantity, idempotency_key, metadata)
    values(r.user_id, 'private_purchase', -r.jc_amount, r.asset_id, r.quantity, p_request_key,
      jsonb_build_object('gross', r.jc_amount, 'jc_price', r.chain_payload -> 'jc_price', 'jc_pull_tx', p_jc_pull_tx, 'jc_vault_tx', p_jc_vault_tx, 'asset_tx', p_asset_tx))
    on conflict (idempotency_key) do nothing;
  select * into ledger_row from public.jc_ledger where idempotency_key = p_request_key;
  if ledger_row.id is null then raise exception 'subscription ledger finalization failed'; end if;
  insert into public.holdings(user_id, asset_id, quantity, updated_at) values(r.user_id, r.asset_id, r.quantity, now())
    on conflict(user_id, asset_id) do update set quantity = public.holdings.quantity + excluded.quantity, updated_at = now();
  new_available := a.available - r.quantity;
  update public.private_placements set available = new_available, updated_at = now(), market_started_at = case when new_available = 0 then coalesce(market_started_at, now()) else market_started_at end where id = r.asset_id;
  if a.is_ae_token and a.ae_token_kind = 'bonus' and new_available = 0 then perform private.resume_ae_daily_after_bonus(a.id, a.release_frozen_at is null); end if;
  perform private.post_referral_commissions(r.user_id, r.asset_id, 'private', r.jc_amount, ledger_row.id, p_request_key || ':commission');
  update public.settlement_reservations set status = 'confirmed', settled_at = now(), updated_at = now(), chain_payload = chain_payload || jsonb_build_object('jc_pull_tx', p_jc_pull_tx, 'jc_vault_tx', p_jc_vault_tx, 'asset_tx', p_asset_tx) where request_key = p_request_key;
  return jsonb_build_object('status', 'confirmed', 'ledger_id', ledger_row.id, 'gross', r.jc_amount, 'quantity', r.quantity, 'entered_secondary_market', new_available = 0);
end;
$function$;
