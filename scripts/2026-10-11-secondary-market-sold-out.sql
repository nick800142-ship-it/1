-- Sold-out assets remain tradable on the secondary market.
-- is_active controls primary-market inventory only; market_started_at and is_delisted control P2P availability.

DO $migration$
DECLARE
  source_definition text;
BEGIN
  SELECT pg_get_functiondef('public.reserve_p2p_escrow_order(text,text,numeric,numeric,uuid,text)'::regprocedure)
    INTO source_definition;
  source_definition := replace(
    source_definition,
    'where id=p_asset_key and not is_delisted and is_active and market_started_at is not null;',
    'where id=p_asset_key and not is_delisted and market_started_at is not null;'
  );
  EXECUTE source_definition;
END
$migration$;
