-- Apify spend becomes recorded, not capped.
-- The ledger stays whole: apify_runs, scan_apify_runs, cost_usd, reserved_usd,
-- accounting_complete and charged_to_scan all keep working exactly as before. What goes is
-- the gate that compared the running totals against a per-scan and per-day maximum and
-- refused to start a run. reserved_usd is now a provisional accounting figure only: it is
-- what the ledger books against a run while it is in flight, before Apify reports the real
-- cost, so the totals mean something for runs that have not finished yet.
begin;

-- The parameter list shrinks, so the old function has to go rather than be replaced.
drop function if exists public.reserve_apify_run(text,text,text,text,jsonb,numeric,numeric,numeric,timestamptz);

create function public.reserve_apify_run(
  p_scan_id text,
  p_query_fingerprint text,
  p_actor text,
  p_build text,
  p_input_json jsonb,
  p_expected_cost_usd numeric,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.apify_runs%rowtype;
  created public.apify_runs%rowtype;
begin
  -- Not a budget: reserved_usd is a non-negative column and a negative booking would
  -- silently corrupt every total built on it.
  if p_expected_cost_usd < 0 then
    raise exception 'Expected Apify cost cannot be negative';
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

  insert into public.apify_runs(query_fingerprint, actor, build, input_json, status, reserved_usd, expires_at)
    values (p_query_fingerprint, p_actor, p_build, p_input_json, 'RESERVED', p_expected_cost_usd, p_expires_at)
    returning * into created;
  if p_scan_id is not null then
    insert into public.scan_apify_runs(scan_id, apify_run_id, charged_to_scan) values (p_scan_id, created.id, true);
  end if;
  return jsonb_build_object('decision', 'start', 'record', to_jsonb(created), 'chargedToScan', true);
end;
$$;

revoke all on function public.reserve_apify_run(text,text,text,text,jsonb,numeric,timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_apify_run(text,text,text,text,jsonb,numeric,timestamptz) to service_role;

commit;
