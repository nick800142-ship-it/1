create or replace function public.activate_special_promo_code(promo text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if upper(trim(promo)) <> 'RWMT88888' then
    raise exception 'unsupported special promo code';
  end if;

  if not exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'not authenticated';
  end if;

  -- Store the special qualification separately from referrer_id.
  -- Requires profiles.special_promo_code text to be added if it does not exist.
  update profiles
  set special_promo_code = 'RWMT88888'
  where id = auth.uid();
end;
$$;

grant execute on function public.activate_special_promo_code(text) to authenticated;

-- Add this column once if the project schema does not already contain it:
-- alter table public.profiles add column if not exists special_promo_code text;
-- create index if not exists profiles_special_promo_code_idx on public.profiles (special_promo_code);
