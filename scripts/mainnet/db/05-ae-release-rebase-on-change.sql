-- 主網：修改 AE 平常日輪次的「釋出間隔／每次數量」時，已釋出份額要沿用、不可重算。
--
-- 已釋出份額 = floor((now - release_started_at) / release_interval_seconds) × release_amount_per_interval
-- （execute_private_purchase 與前台 computeAeTokenRelease 用同一公式）。
-- 舊版直接覆寫間隔，整段歷史改用新間隔重算：5 分鐘 → 6 分鐘時已釋出從 8640 掉到 7200，
-- 導致已售 8639 > 已釋出、目前可認購卡在 0 好幾天。
--
-- 修法：參數變更當下，先用「舊參數」算出已釋出量 R，再把 release_started_at 往回推
-- R / 新數量 × 新間隔 秒，讓新公式在此刻正好等於 R，之後依新速度繼續累加。
-- 不需改 execute_private_purchase 或前台。

create or replace function public.admin_save_ae_token_daily(p_price numeric, p_release_interval_seconds integer, p_release_amount_per_interval numeric, p_name text default 'AE 代幣'::text, p_information text default ''::text, p_image text default '/images/ae-token.png'::text) returns public.private_placements
    language plpgsql security definer
    set search_path to ''
    as $$
declare
  result public.private_placements;
  admin_email text;
  daily_id constant text := 'ae-token-daily';
  existed boolean;
  current_row public.private_placements;
  released_before numeric := null;
  rebased_started_at timestamptz := null;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_price is null or p_price<=0 then raise exception 'invalid price'; end if;
  if p_release_interval_seconds is null or p_release_interval_seconds<=0 then raise exception 'invalid release interval'; end if;
  if p_release_amount_per_interval is null or p_release_amount_per_interval<=0 then raise exception 'invalid release amount'; end if;
  if trim(coalesce(p_name,''))='' then raise exception 'name required'; end if;

  select * into current_row from public.private_placements where id=daily_id for update;
  existed := found;

  if existed
     and current_row.is_active
     and not current_row.is_delisted
     and current_row.release_frozen_at is null
     and current_row.release_started_at is not null
     and coalesce(current_row.release_interval_seconds, 0) > 0
     and coalesce(current_row.release_amount_per_interval, 0) > 0
     and (current_row.release_interval_seconds is distinct from p_release_interval_seconds
          or current_row.release_amount_per_interval is distinct from p_release_amount_per_interval) then
    released_before := least(
      current_row.total_supply,
      greatest(0, floor(extract(epoch from (now() - current_row.release_started_at)) / current_row.release_interval_seconds))
        * current_row.release_amount_per_interval
    );
    rebased_started_at := now() - make_interval(
      secs => (released_before / p_release_amount_per_interval) * p_release_interval_seconds
    );
  end if;

  if existed then
    update public.private_placements
    set price=p_price, valuation=p_price*total_supply, name=trim(p_name),
        information=coalesce(p_information,''), image=p_image, images=array[p_image],
        release_interval_seconds=p_release_interval_seconds,
        release_amount_per_interval=p_release_amount_per_interval,
        available=case when is_delisted or not is_active then total_supply else available end,
        market_started_at=case when is_delisted then now() else market_started_at end,
        release_started_at=case
          when is_delisted or not is_active then now()
          when rebased_started_at is not null then rebased_started_at
          else release_started_at
        end,
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
      'release_amount_per_interval',result.release_amount_per_interval,
      'previous_release_interval_seconds',current_row.release_interval_seconds,
      'previous_release_amount_per_interval',current_row.release_amount_per_interval,
      'released_at_change',released_before
    ));

  return result;
end;
$$;

-- 一次性修復：2026-11-22 17:00:02.685298+00 由 300 秒改為 360 秒，當下以 300 秒已釋出 8640。
-- 把起點改成「變更時間 − 8640 × 360 秒」，此後從 8640 依 6 分鐘 1 枚繼續累加。
update public.private_placements
set release_started_at = timestamptz '2026-11-22 17:00:02.685298+00' - make_interval(secs => 8640 * 360),
    updated_at = now()
where id = 'ae-token-daily'
  and release_interval_seconds = 360
  and release_amount_per_interval = 1
  and release_started_at = timestamptz '2026-10-23 17:00:00.332476+00';
