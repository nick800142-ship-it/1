-- 後台用戶詳細紀錄補上「RWMT 小鎮」找到的 AE 與炸彈紀錄。
-- 小鎮 AE 獎勵只存在 rwmt_town_opens，不會寫進 jc_ledger，所以後台原本看不到。
create or replace function public.admin_get_user_town_transactions(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', 'town-' || o.id::text,
          'kind', case when o.result = 'bomb' then 'bomb' else 'ae' end,
          'house', o.house_index,
          'amount', case when o.result = 'bomb' then abs(o.jc_penalty) else 1 end,
          'tx_hash', o.ae_tx_hash,
          'prize_status', o.prize_status,
          'created_at', o.created_at,
          'paid_at', o.ae_paid_at
        )
        order by o.created_at desc
      ),
      '[]'::jsonb
    )
    from public.rwmt_town_opens o
    where o.user_id = p_user_id
      and o.result = 'ae'
  );
end;
$$;

revoke all on function public.admin_get_user_town_transactions(uuid) from public, anon;
grant execute on function public.admin_get_user_town_transactions(uuid) to authenticated;
