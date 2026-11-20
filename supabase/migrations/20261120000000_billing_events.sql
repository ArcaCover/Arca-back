-- Stripe billing (DN-13 T15, §6.5): the webhook records every event it acts on as processed in the same transaction as what it
-- does. apply_billing_state (20261118000000) covers the events that move a subscription; this function covers the ones that move
-- none: a refund, a dispute, an expired checkout, an action the customer must take, and an event of no known organization. Like
-- the three webapp migrations before it, it is applied to no database yet: it goes with them, after the founder approves (§5.2).
begin;

-- Marks the event processed, with why it was not applied (p_error) and, when it names an organization, its audit row as the
-- system, all or nothing. An event already processed is a duplicate and writes nothing. Two deliveries of the same event wait for
-- each other on its row: the second sees it processed.
create function public.close_billing_event(p_event jsonb, p_org_id uuid, p_error text, p_audit jsonb, p_at timestamptz) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_id text := p_event->>'id';
  v_event public.stripe_events%rowtype;
begin
  if p_org_id is not null then
    perform 1 from public.organizations where id = p_org_id for update;
    if not found then raise exception 'webapp_missing:organization' using errcode = 'P0001'; end if;
  end if;
  insert into public.stripe_events (id, type, livemode, org_id, received_at)
  values (v_event_id, p_event->>'type', (p_event->>'livemode')::boolean, p_org_id, p_at)
  on conflict (id) do nothing;
  update public.stripe_events set attempts = attempts + 1 where id = v_event_id returning * into v_event;
  if v_event.processed_at is not null then return 'duplicate'; end if;
  update public.stripe_events set processed_at = p_at, org_id = p_org_id, last_error = p_error where id = v_event_id;
  if p_org_id is not null and p_audit is not null then
    perform public.append_audit(jsonb_build_object('actor_kind', 'system'), p_org_id, p_audit->>'action', v_event_id,
      coalesce(p_audit->'data', '{}'::jsonb), p_at);
  end if;
  return 'recorded';
end;
$$;

-- Like every function of the webapp: only the back, with the service role, may run it (DN-13 §5.5).
revoke all on function public.close_billing_event(jsonb, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.close_billing_event(jsonb, uuid, text, jsonb, timestamptz) to service_role;

commit;
