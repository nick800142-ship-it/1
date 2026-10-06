create or replace function public.get_my_p2p_orders(
  p_escrow_contract_address text default '0xbfb3456226ca1e46cf2bdb3b2d42619a2b7b8db0'
)
returns jsonb
language sql
security definer
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',o.id,'asset_id',o.asset_id,'side',o.side,'price',o.price,
    'original_quantity',o.original_quantity,'remaining_quantity',o.remaining_quantity,
    'status',o.status,'created_at',o.created_at,'updated_at',o.updated_at,
    'escrow_chain_order_id',o.escrow_chain_order_id,'escrow_mode',o.escrow_mode,
    'escrow_create_tx_hash',o.escrow_create_tx_hash,
    'escrow_contract_address',o.escrow_contract_address
  ) order by o.created_at desc),'[]')
  from public.p2p_orders o
  where o.user_id=auth.uid()
    and (o.escrow_mode is distinct from 'escrow'
      or p_escrow_contract_address is null
      or lower(o.escrow_contract_address)=lower(p_escrow_contract_address))
$function$;

revoke all on function public.get_my_p2p_orders(text) from public,anon;
grant execute on function public.get_my_p2p_orders(text) to authenticated;
