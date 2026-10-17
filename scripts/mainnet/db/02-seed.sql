-- 主網新 Supabase 專案：結構以外的必要設定（在 01-schema.sql 之後執行）。
-- 只有平台設定，沒有任何用戶、交易或測試網資料。

-- 1. 登入時自動建立 profiles（auth.users 觸發器；pg_dump 只匯出 public/private，不含這兩個）。
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
drop trigger if exists sync_auth_user_profile_trigger on auth.users;
create trigger sync_auth_user_profile_trigger after insert or update of email, last_sign_in_at, raw_user_meta_data on auth.users
  for each row execute function public.sync_auth_user_profile();

-- 2. 即時更新（標的與公告變動即時推送到前台）。
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'private_placements') then
    alter publication supabase_realtime add table public.private_placements;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'platform_announcements') then
    alter publication supabase_realtime add table public.platform_announcements;
  end if;
end $$;

-- 3. 標的圖片儲存空間（公開讀取、只有管理員能上傳/修改/刪除）。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('placement-images', 'placement-images', true, 10485760, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;
drop policy if exists placement_images_public_read on storage.objects;
create policy placement_images_public_read on storage.objects for select using (bucket_id = 'placement-images');
drop policy if exists placement_images_admin_insert on storage.objects;
create policy placement_images_admin_insert on storage.objects for insert with check (bucket_id = 'placement-images' and private.is_admin());
drop policy if exists placement_images_admin_update on storage.objects;
create policy placement_images_admin_update on storage.objects for update
  using (bucket_id = 'placement-images' and private.is_admin())
  with check (bucket_id = 'placement-images' and private.is_admin());
drop policy if exists placement_images_admin_delete on storage.objects;
create policy placement_images_admin_delete on storage.objects for delete using (bucket_id = 'placement-images' and private.is_admin());

-- 4. 平台設定：生效 Safe＝主網 Safe，費率與託管合約初始值一致（1% / 1 JC）。
--    JC 買入/贖回價先設 1 USDT，上線前請在後台調整。
insert into public.platform_config (id, safe_treasury_address, active_safe_address, jc_price, jc_redeem_price, p2p_fee_bps, p2p_listing_fee)
values (true, '0x75653E53DE9b7b390e803295DdB4Afc461b55A9b', '0x75653E53DE9b7b390e803295DdB4Afc461b55A9b', 1, 1, 100, 1)
on conflict (id) do update set
  safe_treasury_address = excluded.safe_treasury_address,
  active_safe_address = excluded.active_safe_address;

insert into public.site_visual_effects (id, enabled, effect, color, intensity)
values (true, true, 'sparkles', '#ffffff', 1)
on conflict (id) do nothing;

-- 5. 分潤費率（與測試網目前設定相同，見 commission-rules；之後可在後台調整）。
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('一般用戶', 'ae_coin', 0.00, 0.00, 0.00) on conflict do nothing;
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('代理', 'ae_coin', 0.01000000000000000000, 0.01000000000000000000, 0.00069999999999999990) on conflict do nothing;
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('總代理', 'ae_coin', 0.02000000000000000000, 0.02000000000000000000, 0.00130000000000000000) on conflict do nothing;
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('總代理直屬', 'ae_coin', 0.03000000000000000000, 0.03000000000000000000, 0.00000000000000000000) on conflict do nothing;
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('一般用戶', 'rwa', 0.00, 0.00, 0.00) on conflict do nothing;
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('代理', 'rwa', 0.01000000000000000000, 0.01000000000000000000, 0.00069999999999999990) on conflict do nothing;
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('總代理', 'rwa', 0.02000000000000000000, 0.02000000000000000000, 0.00130000000000000000) on conflict do nothing;
insert into public.commission_settings (agency_role, asset_mode, rate, private_rate, secondary_rate) values ('總代理直屬', 'rwa', 0.03000000000000000000, 0.03000000000000000000, 0.00000000000000000000) on conflict do nothing;
