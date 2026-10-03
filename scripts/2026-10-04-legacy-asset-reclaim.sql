-- The existing action constraint must allow the audited, per-user legacy AE/RWA reclaim flow.
alter table public.onchain_settlements
  drop constraint if exists onchain_settlements_action_check;

alter table public.onchain_settlements
  add constraint onchain_settlements_action_check
  check (action = any (array[
    'mint_jc',
    'subscribe',
    'trade',
    'wire_contracts',
    'commission',
    'list_fee',
    'admin_payout',
    'ae_reclaim_legacy'
  ]));
