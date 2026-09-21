-- Fix: the onchain_settlements action CHECK constraint never included the newer
-- settlement actions `commission` (推廣分潤上鏈派發) and `list_fee` (掛單手續費
-- 入金庫). Every insert for those actions failed the CHECK, so claimSettlement()
-- fell into its "insert failed → treat as already pending/done" branch and the
-- settlement silently no-op'd: no on-chain transfer, no paid_at, forever. This
-- is why commissions and list_fee never settled and "一鍵補發" appeared to do
-- nothing. Broaden the allow-list so those inserts succeed and real on-chain
-- settlement can proceed.
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
    'list_fee'
  ]));
