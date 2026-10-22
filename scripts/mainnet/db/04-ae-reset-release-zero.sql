-- 主網：AE 歸零時把平常日輪次的「已釋出／已售出」重新計算為 0，且不取消二級市場掛單。
-- 已釋出份額 = 釋出排程已過的區間數 × 每區間數量；已售出 = total_supply - available。
-- 歸零後 available 補回 total_supply、release_started_at 重設為現在，重新啟用時前台從 0 開始。
create or replace function public.admin_reset_ae_token() returns jsonb
    language plpgsql security definer
    set search_path to ''
    as $$
declare
  admin_email text;
  ae_ids text[];
  delisted_placements integer;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  select array_agg(id) into ae_ids from public.private_placements where is_ae_token = true;
  if ae_ids is null then
    raise exception 'no ae token found';
  end if;

  with delisted as (
    update public.private_placements
    set is_active = false,
        available = case when id = 'ae-token-daily' then total_supply else 0 end,
        release_started_at = case when id = 'ae-token-daily' then now() else release_started_at end,
        updated_at = now()
    where id = any(ae_ids)
    returning 1
  )
  select count(*) into delisted_placements from delisted;

  select email into admin_email from auth.users where id = auth.uid();
  insert into public.admin_audit_logs(admin_id, admin_email, action, target_type, target_id, details)
  values (auth.uid(), admin_email, 'reset', 'ae_token', 'ae-token-daily',
    jsonb_build_object('cancelled_orders', 0, 'wiped_holdings', 0,
      'delisted_placements', delisted_placements, 'refunded_jc', 0));

  return jsonb_build_object('cancelled_orders', 0, 'wiped_holdings', 0,
    'delisted_placements', delisted_placements, 'refunded_jc', 0);
end;
$$;

-- 重新啟用已停用（歸零後）的平常日輪次時，一併把庫存與釋出起點重設，讓前台從 0 開始。
create or replace function public.admin_save_ae_token_daily(p_price numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text default 'AE 代幣'::text, p_information text default ''::text, p_image text default '/images/ae-token.png'::text) returns public.private_placements
    language plpgsql security definer
    set search_path to ''
    as $$
declare
  result public.private_placements;
  admin_email text;
  daily_id constant text := 'ae-token-daily';
  existed boolean;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_price is null or p_price<=0 then raise exception 'invalid price'; end if;
  if p_release_interval_seconds is null or p_release_interval_seconds<=0 then raise exception 'invalid release interval'; end if;
  if p_release_amount_per_interval is null or p_release_amount_per_interval<=0 then raise exception 'invalid release amount'; end if;
  if trim(coalesce(p_name,''))='' then raise exception 'name required'; end if;

  select exists(select 1 from public.private_placements where id=daily_id) into existed;

  if existed then
    update public.private_placements
    set price=p_price, valuation=p_price*total_supply, name=trim(p_name),
        information=coalesce(p_information,''), image=p_image, images=array[p_image],
        release_interval_seconds=p_release_interval_seconds,
        release_amount_per_interval=p_release_amount_per_interval,
        available=case when is_delisted or not is_active then total_supply else available end,
        market_started_at=case when is_delisted then now() else market_started_at end,
        release_started_at=case when is_delisted or not is_active then now() else release_started_at end,
        ends_at=case when is_delisted then 'infinity'::timestamptz else ends_at end,
        is_delisted=false,
        is_active=true,
        updated_at=now()
    where id=daily_id
    returning * into result;
  else
    insert into public.private_placements(
      id,name,location,address,image,images,price,valuation,total_supply,available,apy,
      information,translations,ends_at,is_active,market_started_at,price_locked_until,
      history,comparables,advantages,
      is_ae_token,ae_token_kind,release_interval_seconds,release_amount_per_interval,release_started_at
    ) values (
      daily_id, trim(p_name), 'AE 代幣', 'AE 代幣', p_image, array[p_image], p_price,
      p_price*1e11, 1e11, 1e11, '',
      coalesce(p_information,''), '{}'::jsonb, 'infinity'::timestamptz, true, now(), null,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      true, 'daily', p_release_interval_seconds, p_release_amount_per_interval, now()
    ) returning * into result;
  end if;

  select email into admin_email from auth.users where id=auth.uid();
  insert into public.admin_audit_logs(admin_id,admin_email,action,target_type,target_id,details)
  values(auth.uid(),admin_email,case when existed then 'update' else 'create' end,'ae_token_daily',result.id,
    jsonb_build_object(
      'price',result.price,
      'release_interval_seconds',result.release_interval_seconds,
      'release_amount_per_interval',result.release_amount_per_interval
    ));

  return result;
end;
$$;

-- 一次性：立刻把目前的 AE 平常日輪次歸零（保留用戶持倉與二級市場掛單）。
update public.private_placements
set available = total_supply, release_started_at = now(), is_active = false, updated_at = now()
where id = 'ae-token-daily';

update public.private_placements
set available = 0, is_active = false, updated_at = now()
where is_ae_token = true and id <> 'ae-token-daily';
