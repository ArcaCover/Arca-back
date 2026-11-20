-- The Stripe catalog ids of a plan per mode (DN-13 §20). One Supabase project serves local development, with a Stripe test key,
-- and production, which gets a live key at launch; a Price or Product id belongs to one mode, so each plan keeps both. The ids
-- stored today are test ids (`npm run stripe:catalog -- --apply` with an rk_test_ key) and stay where they are: stripe_product_id
-- and stripe_price_id are the test pair, and the code that reads them keeps working unchanged. The live pair is new and empty
-- until the live catalog is created (T23). Additive: two nullable columns on plans, nothing dropped or rewritten, no scan table.
begin;

alter table public.plans
  add column stripe_live_product_id text,
  add column stripe_live_price_id text unique;

comment on column public.plans.stripe_product_id is
  'Stripe test mode: the catalog Product of the plan (DN-13 §6.1, §20). Written by npm run stripe:catalog -- --apply with a test key.';
comment on column public.plans.stripe_price_id is
  'Stripe test mode: the catalog Price a checkout of the plan charges with a test key (DN-13 §6.1, §20).';
comment on column public.plans.stripe_live_product_id is
  'Stripe live mode: the catalog Product of the plan (DN-13 §20). Written by npm run stripe:catalog -- --apply --allow-live.';
comment on column public.plans.stripe_live_price_id is
  'Stripe live mode: the catalog Price a checkout of the plan charges with a live key (DN-13 §20).';

commit;
