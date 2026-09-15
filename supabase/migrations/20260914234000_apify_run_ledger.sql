-- Durable Apify query ledger, cache and atomic spend reservation.
begin;

create table public.apify_runs (
  id uuid primary key default gen_random_uuid(),
  query_fingerprint text not null check (query_fingerprint ~ '^[a-f0-9]{64}$'),
  actor text not null,
  build text not null,
  build_id text,
  build_number text,
  input_json jsonb not null,
  run_id text unique,
  dataset_id text,
  status text not null,
  items jsonb check (items is null or jsonb_typeof(items) = 'array'),
  item_count integer not null default 0 check (item_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  cost_usd numeric check (cost_usd is null or cost_usd >= 0),
  reserved_usd numeric not null check (reserved_usd >= 0),
  accounting_complete boolean not null default false,
  partial boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_error text
);
create index apify_runs_fingerprint_idx on public.apify_runs (query_fingerprint, created_at desc);
create index apify_runs_created_idx on public.apify_runs (created_at);

create table public.scan_apify_runs (
  scan_id text not null references public.scans (scan_id) on delete cascade,
  apify_run_id uuid not null references public.apify_runs (id) on delete restrict,
  charged_to_scan boolean not null,
  created_at timestamptz not null default now(),
  primary key (scan_id, apify_run_id)
);

create or replace function public.reserve_apify_run(
  p_scan_id text,
  p_query_fingerprint text,
  p_actor text,
  p_build text,
  p_input_json jsonb,
  p_max_cost_usd numeric,
  p_max_scan_cost_usd numeric,
  p_max_daily_cost_usd numeric,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.apify_runs%rowtype;
  created public.apify_runs%rowtype;
  daily_reserved numeric;
  scan_reserved numeric;
begin
  if p_max_cost_usd <= 0 or p_max_scan_cost_usd <= 0 or p_max_daily_cost_usd <= 0 then
    raise exception 'Apify budgets must be positive';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_query_fingerprint, 0));
  select * into existing from public.apify_runs
    where query_fingerprint = p_query_fingerprint
    order by created_at desc limit 1;

  if existing.id is not null and existing.expires_at > now()
    and (existing.items is not null or existing.dataset_id is not null)
    and (existing.status = 'SUCCEEDED' or existing.partial) then
    if p_scan_id is not null then
      insert into public.scan_apify_runs(scan_id, apify_run_id, charged_to_scan) values (p_scan_id, existing.id, false)
        on conflict do nothing;
    end if;
    return jsonb_build_object('decision', 'reuse', 'record', to_jsonb(existing), 'chargedToScan', false);
  end if;

  if existing.id is not null and existing.expires_at > now()
    and existing.status in ('RESERVED','READY','RUNNING','TIMING-OUT','ABORTING','START_UNCERTAIN') then
    if p_scan_id is not null then
      insert into public.scan_apify_runs(scan_id, apify_run_id, charged_to_scan) values (p_scan_id, existing.id, false)
        on conflict do nothing;
    end if;
    return jsonb_build_object('decision', 'resume', 'record', to_jsonb(existing), 'chargedToScan', false);
  end if;

  if existing.id is not null and existing.expires_at > now() then
    if p_scan_id is not null then
      insert into public.scan_apify_runs(scan_id, apify_run_id, charged_to_scan) values (p_scan_id, existing.id, false)
        on conflict do nothing;
    end if;
    return jsonb_build_object('decision', 'failed', 'record', to_jsonb(existing), 'chargedToScan', false);
  end if;

  select coalesce(sum(case when accounting_complete then coalesce(cost_usd, reserved_usd)
    else reserved_usd end), 0) into daily_reserved
    from public.apify_runs where created_at >= date_trunc('day', now());
  if p_scan_id is null then scan_reserved := 0;
  else
    select coalesce(sum(case when r.accounting_complete then coalesce(r.cost_usd, r.reserved_usd)
      else r.reserved_usd end), 0) into scan_reserved
      from public.apify_runs r join public.scan_apify_runs l on l.apify_run_id = r.id
      where l.scan_id = p_scan_id and l.charged_to_scan;
  end if;

  if daily_reserved + p_max_cost_usd > p_max_daily_cost_usd
    or scan_reserved + p_max_cost_usd > p_max_scan_cost_usd then
    return jsonb_build_object('decision', 'budget_exceeded', 'record', null, 'chargedToScan', false);
  end if;

  insert into public.apify_runs(query_fingerprint, actor, build, input_json, status, reserved_usd, expires_at)
    values (p_query_fingerprint, p_actor, p_build, p_input_json, 'RESERVED', p_max_cost_usd, p_expires_at)
    returning * into created;
  if p_scan_id is not null then
    insert into public.scan_apify_runs(scan_id, apify_run_id, charged_to_scan) values (p_scan_id, created.id, true);
  end if;
  return jsonb_build_object('decision', 'start', 'record', to_jsonb(created), 'chargedToScan', true);
end;
$$;

alter table public.apify_runs enable row level security;
alter table public.scan_apify_runs enable row level security;
revoke all on public.apify_runs, public.scan_apify_runs from anon, authenticated;
grant all on public.apify_runs, public.scan_apify_runs to service_role;
revoke all on function public.reserve_apify_run(text,text,text,text,jsonb,numeric,numeric,numeric,timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_apify_run(text,text,text,text,jsonb,numeric,numeric,numeric,timestamptz) to service_role;

commit;
