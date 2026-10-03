ALTER TABLE public.platform_config
  ADD COLUMN IF NOT EXISTS jc_redeem_price numeric;

UPDATE public.platform_config
SET jc_redeem_price = jc_price
WHERE jc_redeem_price IS NULL;

ALTER TABLE public.platform_config
  ALTER COLUMN jc_redeem_price SET DEFAULT 1,
  ALTER COLUMN jc_redeem_price SET NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_set_jc_redeem_price(new_price numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  u_email text;
begin
  if not private.is_admin() then
    raise exception 'not authorized';
  end if;

  if new_price is null or new_price <= 0 or new_price > 1000000 then
    raise exception 'invalid price';
  end if;

  update public.platform_config
  set jc_redeem_price = round(new_price, 6),
      updated_at = now(),
      updated_by = auth.uid()
  where id = true;

  if not found then
    raise exception 'platform config row is missing';
  end if;

  select email into u_email
  from public.profiles
  where id = auth.uid();

  insert into public.admin_audit_logs(
    admin_id,
    admin_email,
    action,
    target_type,
    target_id,
    details
  )
  values (
    auth.uid(),
    coalesce(u_email, ''),
    'jc.redeem.price.update',
    'platform_config',
    'jc_redeem',
    jsonb_build_object('new_price', round(new_price, 6))
  );

  return round(new_price, 6);
end
$function$;

REVOKE ALL ON FUNCTION public.admin_set_jc_redeem_price(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_jc_redeem_price(numeric) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_jc_redemption(jc_amount numeric, request_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  px numeric;
  usdt numeric;
  jc_bal numeric;
  wallet text;
  r public.jc_ledger;
  order_row public.redemption_orders;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not private.is_account_active(auth.uid()) then
    raise exception 'account is blacklisted' using errcode = '42501';
  end if;

  if request_key is null or length(trim(request_key)) < 8 then
    raise exception 'invalid request key';
  end if;

  if jc_amount is null or jc_amount <= 0 or jc_amount > 100000000 then
    raise exception 'invalid amount';
  end if;

  if exists (
    select 1
    from public.redemption_orders
    where idempotency_key = request_key
  ) then
    return jsonb_build_object('idempotent', true);
  end if;

  select wallet_address
  into wallet
  from public.profiles
  where id = auth.uid();

  if wallet is null or length(trim(wallet)) = 0 then
    raise exception 'no wallet bound';
  end if;

  select jc_redeem_price
  into px
  from public.platform_config
  where id = true;

  if px is null or px <= 0 then
    raise exception 'jc redemption price unavailable';
  end if;

  usdt := round(jc_amount * px, 6);

  if usdt <= 0 then
    raise exception 'invalid amount';
  end if;

  select coalesce(sum(amount) filter (where entry_type <> 'commission_pending'), 0)
  into jc_bal
  from public.jc_ledger
  where user_id = auth.uid();

  if jc_bal < jc_amount then
    raise exception 'insufficient jc';
  end if;

  insert into public.jc_ledger(user_id, entry_type, amount, idempotency_key, metadata)
  values (
    auth.uid(),
    'redemption_pending',
    -jc_amount,
    request_key || ':jc',
    jsonb_build_object('usdt', usdt, 'jc_price', px, 'jc_redeem_price', px)
  )
  returning * into r;

  insert into public.redemption_orders(
    user_id,
    wallet_address,
    jc_amount,
    usdt_amount,
    jc_price,
    jc_ledger_id,
    idempotency_key
  )
  values (auth.uid(), wallet, jc_amount, usdt, px, r.id, request_key)
  returning * into order_row;

  return jsonb_build_object(
    'order_id', order_row.id,
    'jc_amount', jc_amount,
    'usdt_amount', usdt,
    'jc_price', px,
    'status', 'pending'
  );
end
$function$;
