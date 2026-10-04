alter table public.onchain_settlements drop constraint if exists onchain_settlements_status_check;

alter table public.onchain_settlements
  add constraint onchain_settlements_status_check
  check (status = any (array['pending'::text, 'confirmed'::text, 'failed'::text, 'cancelled'::text]));
