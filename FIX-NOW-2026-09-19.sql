-- Run this once in Supabase SQL Editor after deploying this ZIP.
alter table if exists public.profiles
  add column if not exists permissions jsonb not null default '[]'::jsonb,
  add column if not exists permissions_mode text not null default 'custom';

alter table if exists public.representatives
  add column if not exists account_currency text not null default 'USD';

alter table if exists public.recycle_bin
  add column if not exists original_table text;

update public.recycle_bin set original_table = case entity_type
  when 'warehouse' then 'warehouses'
  when 'debtor' then 'customers'
  when 'product' then 'products'
  when 'representative' then 'representatives'
  else original_table end
where original_table is null;

notify pgrst, 'reload schema';
