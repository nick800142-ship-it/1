CREATE OR REPLACE FUNCTION public.admin_sync_jc_chain_balance(
  p_user_id uuid,
  p_wallet text,
  p_chain_balance numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  ledger_balance numeric;
  adjustment numeric;
  sync_key text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION '缺少使用者 ID';
  END IF;
  IF p_wallet IS NULL OR p_wallet !~* '^0x[0-9a-f]{40}$' THEN
    RAISE EXCEPTION '錢包地址格式錯誤';
  END IF;
  IF p_chain_balance IS NULL OR p_chain_balance < 0 OR p_chain_balance > 1000000000000000000 THEN
    RAISE EXCEPTION '鏈上 JC 餘額無效';
  END IF;

  PERFORM 1
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到使用者帳號';
  END IF;

  SELECT COALESCE(
    SUM(l.amount) FILTER (WHERE l.entry_type <> 'commission_pending'),
    0
  )
  INTO ledger_balance
  FROM public.jc_ledger AS l
  WHERE l.user_id = p_user_id;

  adjustment := p_chain_balance - ledger_balance;
  IF adjustment = 0 THEN
    RETURN jsonb_build_object(
      'balance', ledger_balance,
      'adjustment', 0
    );
  END IF;

  sync_key := 'onchain-balance-sync:' || p_user_id::text || ':' || pg_catalog.gen_random_uuid()::text;
  INSERT INTO public.jc_ledger (
    user_id,
    entry_type,
    amount,
    idempotency_key,
    metadata
  ) VALUES (
    p_user_id,
    'onchain_balance_sync',
    adjustment,
    sync_key,
    jsonb_build_object(
      'source', 'current_jc_contract',
      'contract', '0xE035d5A79664843089F9Ee9F8dA2980cfB5eE4D9',
      'wallet', lower(p_wallet),
      'chain_balance', p_chain_balance,
      'ledger_before', ledger_balance
    )
  );

  RETURN jsonb_build_object(
    'balance', p_chain_balance,
    'adjustment', adjustment
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_sync_jc_chain_balance(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_sync_jc_chain_balance(uuid, text, numeric)
  TO service_role;

COMMENT ON FUNCTION public.admin_sync_jc_chain_balance(uuid, text, numeric) IS
  'Service-role only: reconcile JC ledger to the authenticated user wallet balance on the current JC contract. Legacy contract balances are offset, not deleted.';

SELECT
  has_function_privilege('service_role', 'public.admin_sync_jc_chain_balance(uuid,text,numeric)', 'EXECUTE') AS service_role_can_sync,
  has_function_privilege('authenticated', 'public.admin_sync_jc_chain_balance(uuid,text,numeric)', 'EXECUTE') AS authenticated_cannot_sync;
