-- 修復「指定代碼 RWMT88888」啟用後仍顯示未解鎖、且未發自購 3% 回饋的問題
-- 根因：activate_special_promo_code 寫入 'RWMT888888'（6 個 8），但解鎖判定比對 'RWMT88888'（5 個 8）。

create or replace function public.activate_special_promo_code(promo text)
returns void
language plpgsql
set search_path to 'public'
as $function$
begin
  if upper(regexp_replace(trim(promo), '[^A-Za-z0-9]', '', 'g')) <> 'RWMT88888' then
    raise exception 'unsupported special promo code';
  end if;
  if not exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'not authenticated';
  end if;
  update profiles set special_promo_code = 'RWMT88888' where id = auth.uid();
end;
$function$;

-- 任何寫入方式（含歷史錯誤格式）一律正規化成 RWMT88888，避免日後再出現同類落差
create or replace function private.normalize_special_promo_code()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.special_promo_code is not null
     and upper(regexp_replace(new.special_promo_code, '[^A-Za-z0-9]', '', 'g')) in ('RWMT88888', 'RWMT888888') then
    new.special_promo_code := 'RWMT88888';
  end if;
  return new;
end;
$function$;

drop trigger if exists normalize_special_promo_code on public.profiles;
create trigger normalize_special_promo_code
  before insert or update of special_promo_code on public.profiles
  for each row execute function private.normalize_special_promo_code();

-- 修正既有錯誤資料（觸發器會把值正規化）
update public.profiles
   set special_promo_code = 'RWMT88888'
 where upper(regexp_replace(coalesce(special_promo_code, ''), '[^A-Za-z0-9]', '', 'g')) = 'RWMT888888';

-- 補算受害用戶（指定代碼曾被寫成 RWMT888888）所有缺漏的自購回饋；冪等（-self 鍵與 source_ledger_id+beneficiary 唯一）
do $$
declare r record;
begin
  for r in
    select j.id, j.user_id, j.asset_id, -j.amount as gross, j.idempotency_key
      from public.jc_ledger j
     where j.entry_type = 'private_purchase'
       and j.amount < 0
       and j.user_id in (select id from public.profiles where email in ('baby622802@gmail.com', 'wenx9818@gmail.com'))
       and not exists (select 1 from public.commission_logs c where c.source_ledger_id = j.id and c.bonus_type = 'self_rebate')
     order by j.created_at
  loop
    perform private.post_referral_commissions(r.user_id, r.asset_id, 'private', r.gross, r.id, r.idempotency_key);
  end loop;
end $$;
