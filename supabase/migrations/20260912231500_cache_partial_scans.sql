-- Partial scans become reusable evidence.
-- A crawl only reports PARTIAL after every recoverable page has used its retries, so a repeat scan
-- of the same domain within the TTL mostly repeats the paid provider runs for the same evidence.
-- The cache still refuses FAILED scans and scans that were themselves served from cache.
begin;

drop index if exists public.scans_domain_completed_idx;
create index scans_domain_reusable_idx on public.scans (canonical_domain, completed_at desc)
  where status in ('COMPLETED', 'PARTIAL') and not cached;

commit;
