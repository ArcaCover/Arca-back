-- Fresh database baseline. Existing application data does not need to be preserved.
-- Apply to an empty database after resetting the previous schema through the CLI.
begin;

create table public.scans (
  id uuid primary key default gen_random_uuid(),
  scan_id text not null unique check (scan_id ~ '^sc_[a-zA-Z0-9]+$'),
  email text not null,
  canonical_domain text not null check (length(canonical_domain) > 0),
  domain_resolution jsonb not null check ((domain_resolution->>'status' = 'RESOLVED'
    and domain_resolution->>'canonicalDomain' = canonical_domain) is true),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'FAILED', 'PARTIAL')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  cached boolean not null default false,
  constraint completed_scan_has_result check (status not in ('COMPLETED', 'PARTIAL') or result is not null)
);
create index scans_domain_completed_idx on public.scans (canonical_domain, completed_at desc)
  where status = 'COMPLETED' and not cached;

create table public.scan_raw_data (
  id uuid primary key default gen_random_uuid(),
  scan_id text not null references public.scans (scan_id) on delete cascade,
  source text not null check (source in ('website', 'bar', 'avvo')),
  raw_content text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  fetched_at timestamptz not null default now()
);
create index scan_raw_data_scan_source_idx on public.scan_raw_data (scan_id, source, fetched_at desc);

alter table public.scans enable row level security;
alter table public.scan_raw_data enable row level security;
-- Anonymous scan sessions are validated by the backend, not Supabase Auth users.
-- Only the backend service role can read or write source evidence and scan records.
revoke all on public.scans, public.scan_raw_data from anon, authenticated;
grant all on public.scans, public.scan_raw_data to service_role;
commit;
