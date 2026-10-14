alter table public.rwmt_town_opens add column if not exists ae_tx_hash text;
alter table public.rwmt_town_opens add column if not exists ae_paid_at timestamptz;

create or replace function public.get_my_rwmt_town_transactions()
returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', 'town-' || o.id::text,
    'kind', case when o.result = 'bomb' then 'bomb' else 'ae' end,
    'house', o.house_index,
    'amount', case when o.result = 'bomb' then abs(o.jc_penalty) else 1 end,
    'net', case when o.result = 'bomb' then -abs(o.jc_penalty) else 1 end,
    'tx_hash', o.ae_tx_hash,
    'status', case when o.result = 'ae' then case when o.prize_status = 'paid' then 'confirmed' else 'pending' end else 'confirmed' end,
    'created_at', o.created_at,
    'paid_at', o.ae_paid_at
  ) order by o.created_at desc), '[]'::jsonb)
  from public.rwmt_town_opens o
  where o.user_id = auth.uid() and (o.result = 'bomb' or o.result = 'ae');
$$;
revoke all on function public.get_my_rwmt_town_transactions() from public;
grant execute on function public.get_my_rwmt_town_transactions() to authenticated;
