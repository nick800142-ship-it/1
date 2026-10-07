-- The prior seller debit attempted to INSERT a negative row before ON CONFLICT,
-- which violates holdings_quantity_check even when a sufficient holding already exists.
-- Replace that candidate insert with an atomic, balance-guarded UPDATE.
do $migration$
declare
  function_oid oid := to_regprocedure('public.finalize_p2p_escrow_fill(jsonb)');
  function_definition text;
  old_sql text := $old$
  insert into public.holdings(user_id,asset_id,quantity,updated_at) values(v_seller_id,o.asset_id,-v_quantity,now())
    on conflict(user_id,asset_id) do update set quantity=public.holdings.quantity+excluded.quantity,updated_at=now();
$old$;
  new_sql text := $new$
  update public.holdings
    set quantity = quantity - v_quantity, updated_at = now()
    where user_id = v_seller_id
      and asset_id = o.asset_id
      and quantity >= v_quantity;
  if not found then
    raise exception 'seller holdings are insufficient for escrow fill';
  end if;
$new$;
begin
  if function_oid is null then
    raise exception 'Required function public.finalize_p2p_escrow_fill(jsonb) is missing';
  end if;

  function_definition := pg_get_functiondef(function_oid);
  if position(new_sql in function_definition) = 0 then
    if position(old_sql in function_definition) = 0 then
      raise exception 'Expected seller holdings debit not found; refusing to modify an unexpected function version';
    end if;
    execute replace(function_definition, old_sql, new_sql);
    function_definition := pg_get_functiondef(function_oid);
  end if;

  if position(new_sql in function_definition) = 0 then
    raise exception 'Seller holdings debit patch verification failed';
  end if;
end
$migration$;

notify pgrst, 'reload schema';
