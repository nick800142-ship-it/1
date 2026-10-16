-- AE 二級市場允許最多 6 位小數份額；原本 p2p_orders 的表層約束強制整數，
-- 導致 0.5 AE 等小數掛單在鏈上託管成功後，寫入帳本時被拒。
-- RWA 份額仍必須整數，由 reserve/create/fill/settle 等 RPC 依 is_ae_token 分支檢查。
alter table public.p2p_orders drop constraint p2p_orders_original_quantity_check;
alter table public.p2p_orders drop constraint p2p_orders_remaining_quantity_check;
alter table public.p2p_orders add constraint p2p_orders_original_quantity_check
  check (original_quantity > 0 and original_quantity = round(original_quantity, 6));
alter table public.p2p_orders add constraint p2p_orders_remaining_quantity_check
  check (remaining_quantity >= 0 and remaining_quantity = round(remaining_quantity, 6));
