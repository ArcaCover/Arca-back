-- Real accounts and billing (DN-13 §5.3–§5.5): what the cobro real needs, and the RPC functions that make every multi-row
-- write of the webapp one transaction. supabase-js (PostgREST) opens no transaction across statements, so the repository calls
-- these functions instead. Like the DN-10 and DN-11 migrations, it is not applied to any database yet: the three go together and
-- in order, after the founder approves (DN-13 §5.2).
--
-- Errors the repository translates carry a fixed message with errcode P0001:
--   webapp_conflict:<reason>    a rule of the data model (WebappConflict), e.g. webapp_conflict:scan_claimed
--   webapp_refused:member_change the actor's right over the member no longer holds (DN-11 race, DN-13 §4.6)
--   webapp_ineligible_assignee  the assignee cannot hold an action (DN-11 D11)
--   webapp_missing:<record>     the record the write names does not exist
--   webapp_duplicate:<record>   a record with that identity already exists
--   webapp_invalid:<record>     the records do not belong together
begin;

-- §5.3 ---------------------------------------------------------------------------------------------------------------------

-- Stripe customer of an organization: created by the API on the first checkout, never by the browser.
create table public.billing_customers (
  org_id uuid primary key references public.organizations(id) on delete restrict,
  customer_id text not null unique check (customer_id ~ '^cus_[A-Za-z0-9]+$'),
  livemode boolean not null,
  created_at timestamptz not null default now()
);

-- One open checkout per organization, so two owners clicking "Pay" do not start two subscriptions.
create table public.checkout_sessions (
  id text primary key check (id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  org_id uuid not null references public.organizations(id) on delete restrict,
  plan_code text not null references public.plans(code) on delete restrict,
  url text not null,
  status text not null default 'open' check (status in ('open','complete','expired')),
  created_by uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index checkout_sessions_open_idx on public.checkout_sessions(org_id) where status = 'open';

-- The catalog price a plan charges. amount_cents, currency and interval mirror it for display; a price change creates a
-- new Stripe price and moves these columns together (DN-13 §6.1).
alter table public.plans
  add column stripe_product_id text,
  add column stripe_price_id text unique;

-- What Stripe last said, kept raw beside the mapped status (DN-13 §6.6).
alter table public.subscriptions
  add column provider_status text,
  add column price_id text,
  add column cancel_at_period_end boolean not null default false,
  add column current_period_start timestamptz,
  add column livemode boolean;
create unique index subscriptions_subscription_idx on public.subscriptions(subscription_id) where subscription_id is not null;

-- An event is "seen" when inserted and "done" when processed_at is set; only a processed event is skipped (DN-13 §6.5).
alter table public.stripe_events
  add column livemode boolean,
  add column org_id uuid,
  add column attempts integer not null default 0,
  add column last_error text;
create index stripe_events_received_idx on public.stripe_events(received_at);

-- Account deletion (DN-13 §4.8): the profile stays as a tombstone with no email.
alter table public.profiles
  add column deleted_at timestamptz,
  alter column email drop not null,
  add constraint profiles_email_unless_deleted check ((deleted_at is null) = (email is not null));
create unique index profiles_email_idx on public.profiles(lower(email)) where deleted_at is null;

-- Lookups the service does today by scanning lists.
create index invitations_email_idx on public.invitations(lower(email)) where accepted_at is null and revoked_at is null;
create index claim_tickets_expiry_idx on public.claim_tickets(expires_at);

-- Helpers (not callable by any client role) ---------------------------------------------------------------------------------

-- canManageMember of @arca/contracts, as SQL. A PGlite test walks the whole matrix against the TypeScript version.
create function public.can_manage_member(p_actor text, p_target text, p_next text) returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$
  select case p_actor when 'owner' then true when 'admin' then p_target <> 'owner' and p_next is distinct from 'owner' else false end;
$$;

-- can(role, 'actions.update'): who may hold an action of the plan (DN-11 D11).
create function public.can_hold_actions(p_role text) returns boolean
language sql immutable
set search_path = pg_catalog, public
as $$ select p_role in ('owner','admin','member'); $$;

-- One audit row, its actor as the service decided it ({ actor_kind, actor_user_id }).
create function public.append_audit(p_actor jsonb, p_org_id uuid, p_action text, p_target text, p_data jsonb, p_at timestamptz)
returns void
language sql
set search_path = pg_catalog, public
as $$
  insert into public.audit_log (actor_kind, actor_user_id, org_id, action, target, data, created_at)
  values (p_actor->>'actor_kind', (p_actor->>'actor_user_id')::uuid, p_org_id, p_action, p_target, p_data, p_at);
$$;

-- Raises IneligibleAssignee unless the user is a member of the organization whose role can hold actions. The row lock conflicts
-- with the one set_member_role and remove_member take, so an assignment and a demotion never pass each other.
create function public.require_assignee(p_org_id uuid, p_user_id uuid) returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_role text;
begin
  if p_user_id is null then return; end if;
  select role into v_role from public.memberships where org_id = p_org_id and user_id = p_user_id for share;
  if v_role is null or not public.can_hold_actions(v_role) then
    raise exception 'webapp_ineligible_assignee' using errcode = 'P0001';
  end if;
end;
$$;

-- The tracked columns of an action, moved only where the patch names them (a key present, null included).
create function public.patched_action(p_row public.org_actions, p_patch jsonb) returns public.org_actions
language plpgsql immutable
set search_path = pg_catalog, public
as $$
begin
  if p_patch ? 'status' then p_row.status := p_patch->>'status'; end if;
  if p_patch ? 'assignee_user_id' then p_row.assignee_user_id := (p_patch->>'assignee_user_id')::uuid; end if;
  if p_patch ? 'due_date' then p_row.due_date := (p_patch->>'due_date')::date; end if;
  p_row.updated_by := (p_patch->>'updated_by')::uuid;
  p_row.updated_at := (p_patch->>'updated_at')::timestamptz;
  return p_row;
end;
$$;

-- §5.4 RPC functions ------------------------------------------------------------------------------------------------------

-- The organization, its first owner and the claimed analysis, together or not at all.
create function public.create_organization(p_org jsonb, p_owner jsonb, p_analysis jsonb) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id uuid := (p_org->>'id')::uuid;
  v_analysis jsonb := nullif(p_analysis, 'null'::jsonb);
  v_constraint text;
begin
  if p_owner->>'role' is distinct from 'owner' or (p_owner->>'org_id')::uuid is distinct from v_org_id
    or (v_analysis is not null and (v_analysis->>'org_id')::uuid is distinct from v_org_id) then
    raise exception 'webapp_invalid:organization' using errcode = 'P0001';
  end if;
  insert into public.organizations (id, name, domain, billing_status, deleted_at, created_by, created_at)
  values (v_org_id, p_org->>'name', p_org->>'domain', p_org->>'billing_status', (p_org->>'deleted_at')::timestamptz,
    (p_org->>'created_by')::uuid, (p_org->>'created_at')::timestamptz);
  insert into public.memberships (org_id, user_id, role, invited_by, created_at)
  values (v_org_id, (p_owner->>'user_id')::uuid, 'owner', (p_owner->>'invited_by')::uuid, (p_owner->>'created_at')::timestamptz);
  if v_analysis is not null then
    insert into public.org_analyses (org_id, scan_id, assessment_id, claimed_by, claimed_at)
    values (v_org_id, v_analysis->>'scan_id', v_analysis->>'assessment_id', (v_analysis->>'claimed_by')::uuid,
      (v_analysis->>'claimed_at')::timestamptz);
  end if;
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'org_analyses_scan_id_key' then raise exception 'webapp_conflict:scan_claimed' using errcode = 'P0001'; end if;
  if v_constraint = 'organizations_pkey' then raise exception 'webapp_duplicate:organization' using errcode = 'P0001'; end if;
  raise;
end;
$$;

-- Another analysis for an organization that exists. A scan belongs to one organization only.
create function public.claim_analysis(p_analysis jsonb) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.org_analyses (org_id, scan_id, assessment_id, claimed_by, claimed_at)
  values ((p_analysis->>'org_id')::uuid, p_analysis->>'scan_id', p_analysis->>'assessment_id', (p_analysis->>'claimed_by')::uuid,
    (p_analysis->>'claimed_at')::timestamptz);
exception when unique_violation then
  raise exception 'webapp_conflict:scan_claimed' using errcode = 'P0001';
end;
$$;

-- True only for the call that spends the ticket.
create function public.redeem_claim_ticket(p_id_hash text, p_at timestamptz) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.claim_tickets set used_at = p_at where id_hash = p_id_hash and used_at is null;
  return found;
end;
$$;

-- Membership (unless they already belong, who keep their role), acceptance, every other pending link of that email in the
-- organization revoked, and the audit, in one step. The lock on the invitation makes the second of two racing accepts see it closed.
create function public.accept_invitation(p_invitation_id uuid, p_user_id uuid, p_actor jsonb, p_at timestamptz) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invitation public.invitations%rowtype;
  v_role text;
  v_joined boolean := false;
begin
  select * into v_invitation from public.invitations where id = p_invitation_id for update;
  if not found then raise exception 'webapp_missing:invitation' using errcode = 'P0001'; end if;
  if v_invitation.accepted_at is not null or v_invitation.revoked_at is not null then
    raise exception 'webapp_conflict:invitation_closed' using errcode = 'P0001';
  end if;
  select role into v_role from public.memberships where org_id = v_invitation.org_id and user_id = p_user_id for update;
  if v_role is null then
    insert into public.memberships (org_id, user_id, role, invited_by, created_at)
    values (v_invitation.org_id, p_user_id, v_invitation.role, v_invitation.invited_by, p_at);
    v_role := v_invitation.role;
    v_joined := true;
  end if;
  update public.invitations set accepted_at = p_at where id = v_invitation.id;
  -- No other link stays live, or a member removed later could use it to come back.
  with revoked as (
    update public.invitations set revoked_at = p_at
    where org_id = v_invitation.org_id and lower(email) = lower(v_invitation.email) and id <> v_invitation.id
      and accepted_at is null and revoked_at is null
    returning id, email
  )
  insert into public.audit_log (actor_kind, actor_user_id, org_id, action, target, data, created_at)
  select p_actor->>'actor_kind', (p_actor->>'actor_user_id')::uuid, v_invitation.org_id, 'invitation.revoked', email,
    jsonb_build_object('invitationId', id, 'reason', 'accepted'), p_at
  from revoked order by id;
  if v_joined then
    perform public.append_audit(p_actor, v_invitation.org_id, 'member.joined', p_user_id::text,
      jsonb_build_object('role', v_role, 'invitationId', v_invitation.id), p_at);
  end if;
  return jsonb_build_object('joined', v_joined, 'role', v_role);
end;
$$;

-- The checks both member changes run under their locks: the actor still holds the role the service checked, and that role can
-- still act on the target's role as it is now (the race DN-11 left in types.ts). Owner changes of one organization are serialized
-- with the same advisory lock as guard_last_owner, so the last-owner check below is exact. Returns the target's role, or null
-- when they are not a member.
create function public.lock_member_change(p_org_id uuid, p_user_id uuid, p_next text, p_actor_user_id uuid, p_actor_role text,
  p_removing boolean) returns text
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor text;
  v_before text;
begin
  perform pg_advisory_xact_lock(hashtextextended('owners:' || p_org_id::text, 0));
  select role into v_actor from public.memberships where org_id = p_org_id and user_id = p_actor_user_id for share;
  if v_actor is distinct from p_actor_role then raise exception 'webapp_refused:member_change' using errcode = 'P0001'; end if;
  select role into v_before from public.memberships where org_id = p_org_id and user_id = p_user_id for update;
  if v_before is null then return null; end if;
  if not public.can_manage_member(p_actor_role, v_before, case when p_removing then null else p_next end) then
    raise exception 'webapp_refused:member_change' using errcode = 'P0001';
  end if;
  if v_before = 'owner' and (p_removing or p_next <> 'owner') and not exists (
    select 1 from public.memberships where org_id = p_org_id and role = 'owner' and user_id <> p_user_id) then
    raise exception 'webapp_conflict:last_owner' using errcode = 'P0001';
  end if;
  return v_before;
end;
$$;

-- A new role; a role that cannot hold actions (a viewer) releases them in the same step (DN-11 D11). Audits the role it found.
create function public.set_member_role(p_org_id uuid, p_user_id uuid, p_role text, p_actor_user_id uuid, p_actor_role text,
  p_audit jsonb, p_at timestamptz) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before text := public.lock_member_change(p_org_id, p_user_id, p_role, p_actor_user_id, p_actor_role, false);
begin
  if v_before is null or v_before = p_role then return v_before; end if;
  update public.memberships set role = p_role where org_id = p_org_id and user_id = p_user_id;
  if not public.can_hold_actions(p_role) then
    update public.org_actions set assignee_user_id = null where org_id = p_org_id and assignee_user_id = p_user_id;
  end if;
  perform public.append_audit(p_audit, p_org_id, 'member.role_changed', p_user_id::text,
    jsonb_build_object('from', v_before, 'to', p_role), p_at);
  return v_before;
end;
$$;

-- The member goes, their actions go back to nobody (DN-11 D15) and their pending links in the organization are revoked.
create function public.remove_member(p_org_id uuid, p_user_id uuid, p_actor_user_id uuid, p_actor_role text, p_audit jsonb,
  p_at timestamptz) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_before text := public.lock_member_change(p_org_id, p_user_id, null, p_actor_user_id, p_actor_role, true);
  v_email text;
begin
  if v_before is null then return null; end if;
  delete from public.memberships where org_id = p_org_id and user_id = p_user_id;
  update public.org_actions set assignee_user_id = null where org_id = p_org_id and assignee_user_id = p_user_id;
  perform public.append_audit(p_audit, p_org_id, 'member.removed', p_user_id::text, jsonb_build_object('role', v_before), p_at);
  select email into v_email from public.profiles where user_id = p_user_id;
  if v_email is not null then
    with revoked as (
      update public.invitations set revoked_at = p_at
      where org_id = p_org_id and lower(email) = lower(v_email) and accepted_at is null and revoked_at is null
      returning id, email
    )
    insert into public.audit_log (actor_kind, actor_user_id, org_id, action, target, data, created_at)
    select p_audit->>'actor_kind', (p_audit->>'actor_user_id')::uuid, p_org_id, 'invitation.revoked', email,
      jsonb_build_object('invitationId', id, 'reason', 'member_removed'), p_at
    from revoked order by id;
  end if;
  return v_before;
end;
$$;

-- True only for the call that revoked a pending invitation of this organization; the second of two revokes writes nothing.
create function public.revoke_invitation(p_org_id uuid, p_invitation_id uuid, p_reason text, p_audit jsonb, p_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_email text;
begin
  update public.invitations set revoked_at = p_at
  where id = p_invitation_id and org_id = p_org_id and accepted_at is null and revoked_at is null
  returning email into v_email;
  if not found then return false; end if;
  perform public.append_audit(p_audit, p_org_id, 'invitation.revoked', v_email,
    case when p_reason is null then jsonb_build_object('invitationId', p_invitation_id)
      else jsonb_build_object('invitationId', p_invitation_id, 'reason', p_reason) end, p_at);
  return true;
end;
$$;

-- The first change of an action of the assessment creates its row as given; later ones move only what the patch names.
create function public.upsert_assessment_action(p_action jsonb, p_patch jsonb) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id uuid := (p_action->>'org_id')::uuid;
  v_row public.org_actions%rowtype;
  v_constraint text;
begin
  if not exists (select 1 from public.org_analyses where org_id = v_org_id and scan_id = p_action->>'scan_id') then
    raise exception 'webapp_missing:analysis' using errcode = 'P0001';
  end if;
  select * into v_row from public.org_actions
  where org_id = v_org_id and scan_id = p_action->>'scan_id' and action_key = p_action->>'action_key' and source = 'assessment'
  for update;
  if found then
    if p_patch ? 'assignee_user_id' then perform public.require_assignee(v_org_id, (p_patch->>'assignee_user_id')::uuid); end if;
    v_row := public.patched_action(v_row, p_patch);
    update public.org_actions set status = v_row.status, assignee_user_id = v_row.assignee_user_id, due_date = v_row.due_date,
      updated_by = v_row.updated_by, updated_at = v_row.updated_at
    where id = v_row.id returning * into v_row;
    return to_jsonb(v_row);
  end if;
  perform public.require_assignee(v_org_id, (p_action->>'assignee_user_id')::uuid);
  -- A first write that raced another lands on its row and only applies its patch.
  insert into public.org_actions (id, org_id, source, scan_id, action_key, status, assignee_user_id, due_date, created_by, created_at,
    updated_by, updated_at)
  values ((p_action->>'id')::uuid, v_org_id, 'assessment', p_action->>'scan_id', p_action->>'action_key', p_action->>'status',
    (p_action->>'assignee_user_id')::uuid, (p_action->>'due_date')::date, (p_action->>'created_by')::uuid,
    (p_action->>'created_at')::timestamptz, (p_action->>'updated_by')::uuid, (p_action->>'updated_at')::timestamptz)
  on conflict (org_id, scan_id, action_key) where source = 'assessment' do update set
    status = case when p_patch ? 'status' then excluded.status else org_actions.status end,
    assignee_user_id = case when p_patch ? 'assignee_user_id' then excluded.assignee_user_id else org_actions.assignee_user_id end,
    due_date = case when p_patch ? 'due_date' then excluded.due_date else org_actions.due_date end,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into v_row;
  return to_jsonb(v_row);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'org_actions_pkey' then raise exception 'webapp_duplicate:action' using errcode = 'P0001'; end if;
  raise;
end;
$$;

-- An action of the organization's own. The organization row lock makes the count and the insert one step (at most 100).
create function public.create_custom_action(p_action jsonb) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id uuid := (p_action->>'org_id')::uuid;
begin
  perform 1 from public.organizations where id = v_org_id for update;
  if not found then raise exception 'webapp_missing:organization' using errcode = 'P0001'; end if;
  if exists (select 1 from public.org_actions where id = (p_action->>'id')::uuid) then
    raise exception 'webapp_duplicate:action' using errcode = 'P0001';
  end if;
  if (select count(*) from public.org_actions where org_id = v_org_id and source = 'custom') >= 100 then
    raise exception 'webapp_conflict:action_limit' using errcode = 'P0001';
  end if;
  perform public.require_assignee(v_org_id, (p_action->>'assignee_user_id')::uuid);
  insert into public.org_actions (id, org_id, source, title, detail, domain, status, assignee_user_id, due_date, created_by, created_at,
    updated_by, updated_at)
  values ((p_action->>'id')::uuid, v_org_id, 'custom', p_action->>'title', p_action->>'detail', p_action->>'domain', p_action->>'status',
    (p_action->>'assignee_user_id')::uuid, (p_action->>'due_date')::date, (p_action->>'created_by')::uuid,
    (p_action->>'created_at')::timestamptz, (p_action->>'updated_by')::uuid, (p_action->>'updated_at')::timestamptz);
end;
$$;

-- An action of either source by id within its organization; null when it is not there, as when another request deleted it.
create function public.update_action(p_org_id uuid, p_action_id uuid, p_patch jsonb) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.org_actions%rowtype;
begin
  select * into v_row from public.org_actions where org_id = p_org_id and id = p_action_id for update;
  if not found then return null; end if;
  if p_patch ? 'assignee_user_id' then perform public.require_assignee(p_org_id, (p_patch->>'assignee_user_id')::uuid); end if;
  v_row := public.patched_action(v_row, p_patch);
  update public.org_actions set status = v_row.status, assignee_user_id = v_row.assignee_user_id, due_date = v_row.due_date,
    updated_by = v_row.updated_by, updated_at = v_row.updated_at
  where id = v_row.id returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- Records a provider event and applies the subscription state it leads to, all or nothing (DN-13 §6.5 step 7). p_event is
-- { id, type, livemode }; p_state is the state already mapped to a billing status (§6.6), fields left null keep what is stored.
-- Returns 'applied', 'duplicate' (already processed), 'duplicate_subscription' (another live subscription that pays: audited,
-- not applied) or 'stale_subscription' (an event of another subscription that gives no access: only marked processed).
create function public.apply_billing_state(p_event jsonb, p_org_id uuid, p_state jsonb, p_at timestamptz) returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_id text := p_event->>'id';
  v_event public.stripe_events%rowtype;
  v_current public.subscriptions%rowtype;
  v_subscription text := p_state->>'subscription_id';
  v_status text := p_state->>'status';
  v_plan text;
begin
  perform 1 from public.organizations where id = p_org_id for update;
  if not found then raise exception 'webapp_missing:organization' using errcode = 'P0001'; end if;
  insert into public.stripe_events (id, type, livemode, org_id, received_at)
  values (v_event_id, p_event->>'type', (p_event->>'livemode')::boolean, p_org_id, p_at)
  on conflict (id) do nothing;
  update public.stripe_events set attempts = attempts + 1 where id = v_event_id returning * into v_event;
  if v_event.processed_at is not null then return 'duplicate'; end if;

  select * into v_current from public.subscriptions where org_id = p_org_id for update;
  -- An old subscription never overwrites the stored one; a new one takes its place only once the stored one is canceled.
  if v_current.subscription_id is not null and v_subscription is not null and v_subscription <> v_current.subscription_id
    and v_current.status <> 'canceled' then
    update public.stripe_events set processed_at = p_at, org_id = p_org_id, last_error = 'other_subscription' where id = v_event_id;
    if v_status in ('active','past_due') then
      perform public.append_audit(jsonb_build_object('actor_kind', 'system'), p_org_id, 'billing.duplicate_subscription', v_event_id,
        jsonb_build_object('type', p_event->>'type', 'subscriptionId', v_subscription, 'current', v_current.subscription_id), p_at);
      return 'duplicate_subscription';
    end if;
    return 'stale_subscription';
  end if;

  v_plan := coalesce(p_state->>'plan_code', v_current.plan_code);
  -- A state that names no plan, for an organization that never subscribed, only moves billing_status.
  if v_plan is not null then
    insert into public.subscriptions (org_id, plan_code, customer_id, subscription_id, status, current_period_end, updated_at,
      provider_status, price_id, cancel_at_period_end, current_period_start, livemode)
    values (p_org_id, v_plan, coalesce(p_state->>'customer_id', v_current.customer_id), coalesce(v_subscription, v_current.subscription_id),
      v_status, coalesce((p_state->>'current_period_end')::timestamptz, v_current.current_period_end), p_at,
      coalesce(p_state->>'provider_status', v_current.provider_status), coalesce(p_state->>'price_id', v_current.price_id),
      coalesce((p_state->>'cancel_at_period_end')::boolean, v_current.cancel_at_period_end, false),
      coalesce((p_state->>'current_period_start')::timestamptz, v_current.current_period_start),
      coalesce((p_state->>'livemode')::boolean, v_current.livemode))
    on conflict (org_id) do update set plan_code = excluded.plan_code, customer_id = excluded.customer_id,
      subscription_id = excluded.subscription_id, status = excluded.status, current_period_end = excluded.current_period_end,
      updated_at = excluded.updated_at, provider_status = excluded.provider_status, price_id = excluded.price_id,
      cancel_at_period_end = excluded.cancel_at_period_end, current_period_start = excluded.current_period_start,
      livemode = excluded.livemode;
  end if;
  -- billing_status is the entitlement, and only this function moves it (DN-13 §6.6). The deletion state never changes here.
  update public.organizations set billing_status = v_status where id = p_org_id;
  update public.stripe_events set processed_at = p_at, org_id = p_org_id, last_error = null where id = v_event_id;
  perform public.append_audit(jsonb_build_object('actor_kind', 'system'), p_org_id, 'billing.event_applied', v_event_id,
    jsonb_build_object('type', p_event->>'type', 'status', v_status, 'planCode', v_plan), p_at);
  return 'applied';
end;
$$;

-- Review, the deletion mark when approved, and the audit, in one step. The second of two reviews is a conflict (a 409), not an
-- error, and changes nothing.
create function public.review_deletion_request(p_request_id uuid, p_status text, p_reviewed_by uuid, p_note text, p_audit jsonb,
  p_at timestamptz) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.deletion_requests%rowtype;
begin
  if p_status not in ('approved','rejected') then raise exception 'webapp_invalid:deletion_review' using errcode = 'P0001'; end if;
  select * into v_request from public.deletion_requests where id = p_request_id for update;
  if not found then raise exception 'webapp_missing:deletion_request' using errcode = 'P0001'; end if;
  if v_request.status <> 'pending' then raise exception 'webapp_conflict:already_reviewed' using errcode = 'P0001'; end if;
  update public.deletion_requests set status = p_status, reviewed_by = p_reviewed_by, reviewed_at = p_at, review_note = p_note
  where id = p_request_id;
  if p_status = 'approved' then
    update public.organizations set deleted_at = coalesce(deleted_at, p_at) where id = v_request.org_id;
  end if;
  perform public.append_audit(p_audit, v_request.org_id, 'org.deletion_' || p_status, p_request_id::text,
    jsonb_build_object('note', p_note), p_at);
end;
$$;

-- DELETE /me (DN-13 §4.8). Refused while the user is the only owner of an organization that is not deleted (sole_owner).
-- Otherwise: their memberships in live organizations go (a deleted organization keeps its history and its last owner), their
-- actions there are released, every pending link to their email is revoked, and the profile becomes a tombstone with no email
-- or name. Returns the organizations that lost the member; a second call finds nothing left to do.
create function public.delete_account(p_user_id uuid, p_at timestamptz) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_membership record;
  v_orgs jsonb := '[]'::jsonb;
  v_email text;
begin
  for v_membership in
    select m.org_id, m.role from public.memberships m join public.organizations o on o.id = m.org_id
    where m.user_id = p_user_id and o.deleted_at is null order by m.org_id for update of m
  loop
    if v_membership.role = 'owner' then
      perform pg_advisory_xact_lock(hashtextextended('owners:' || v_membership.org_id::text, 0));
      if not exists (select 1 from public.memberships where org_id = v_membership.org_id and role = 'owner' and user_id <> p_user_id) then
        raise exception 'webapp_conflict:sole_owner' using errcode = 'P0001';
      end if;
    end if;
  end loop;
  for v_membership in
    select m.org_id, m.role from public.memberships m join public.organizations o on o.id = m.org_id
    where m.user_id = p_user_id and o.deleted_at is null order by m.org_id
  loop
    delete from public.memberships where org_id = v_membership.org_id and user_id = p_user_id;
    update public.org_actions set assignee_user_id = null where org_id = v_membership.org_id and assignee_user_id = p_user_id;
    perform public.append_audit(jsonb_build_object('actor_kind', 'member', 'actor_user_id', p_user_id), v_membership.org_id,
      'account.deleted', p_user_id::text, jsonb_build_object('role', v_membership.role), p_at);
    v_orgs := v_orgs || to_jsonb(v_membership.org_id);
  end loop;
  select email into v_email from public.profiles where user_id = p_user_id for update;
  if v_email is not null then
    with revoked as (
      update public.invitations set revoked_at = p_at
      where lower(email) = lower(v_email) and accepted_at is null and revoked_at is null
      returning id, org_id, email
    )
    insert into public.audit_log (actor_kind, actor_user_id, org_id, action, target, data, created_at)
    select 'member', p_user_id, org_id, 'invitation.revoked', email, jsonb_build_object('invitationId', id, 'reason', 'account_deleted'), p_at
    from revoked order by id;
  end if;
  update public.profiles set deleted_at = coalesce(deleted_at, p_at), email = null, full_name = null, last_org_id = null
  where user_id = p_user_id;
  return jsonb_build_object('orgs', v_orgs);
end;
$$;

-- The platform role (DN-13 §4.5, `npm run admin:grant`). True when it changed; the audit row, when an actor is given, is written
-- only then. granted_by is null when a script grants it.
create function public.grant_platform_admin(p_user_id uuid, p_granted_by uuid, p_audit jsonb, p_at timestamptz) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.platform_admins (user_id, granted_by, created_at) values (p_user_id, p_granted_by, p_at)
  on conflict (user_id) do nothing;
  if not found then return false; end if;
  if nullif(p_audit, 'null'::jsonb) is not null then
    perform public.append_audit(p_audit, null, 'platform_admin.granted', p_user_id::text, '{}'::jsonb, p_at);
  end if;
  return true;
end;
$$;

create function public.revoke_platform_admin(p_user_id uuid, p_audit jsonb, p_at timestamptz) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.platform_admins where user_id = p_user_id;
  if not found then return false; end if;
  if nullif(p_audit, 'null'::jsonb) is not null then
    perform public.append_audit(p_audit, null, 'platform_admin.revoked', p_user_id::text, '{}'::jsonb, p_at);
  end if;
  return true;
end;
$$;

-- A page of the audit log, newest first by (created_at, seq) (DN-11 §4.3), which PostgREST filters cannot express. With p_scoped,
-- only the rows of p_org_id. The cursor row is looked up within the same filter: a seq of another organization gives an empty page.
create function public.list_audit(p_org_id uuid, p_scoped boolean, p_before bigint, p_limit integer) returns jsonb
language sql stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc, page.seq desc), '[]'::jsonb)
  from (
    select a.* from public.audit_log a
    where (not p_scoped or a.org_id = p_org_id)
      and (p_before is null or (a.created_at, a.seq) < (
        select c.created_at, c.seq from public.audit_log c where c.seq = p_before and (not p_scoped or c.org_id = p_org_id)))
    order by a.created_at desc, a.seq desc
    limit p_limit
  ) page;
$$;

-- §5.5 Row Level Security and grants ---------------------------------------------------------------------------------------

alter table public.billing_customers enable row level security;
alter table public.checkout_sessions enable row level security;

revoke all on public.billing_customers, public.checkout_sessions from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.billing_customers, public.checkout_sessions to service_role;

-- Every new function is executable by PUBLIC unless revoked, and PostgREST exposes the functions of public as /rpc/…
revoke all on function public.can_manage_member(text, text, text), public.can_hold_actions(text),
  public.append_audit(jsonb, uuid, text, text, jsonb, timestamptz), public.require_assignee(uuid, uuid),
  public.patched_action(public.org_actions, jsonb), public.lock_member_change(uuid, uuid, text, uuid, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.create_organization(jsonb, jsonb, jsonb), public.claim_analysis(jsonb),
  public.redeem_claim_ticket(text, timestamptz), public.accept_invitation(uuid, uuid, jsonb, timestamptz),
  public.set_member_role(uuid, uuid, text, uuid, text, jsonb, timestamptz), public.remove_member(uuid, uuid, uuid, text, jsonb, timestamptz),
  public.revoke_invitation(uuid, uuid, text, jsonb, timestamptz), public.upsert_assessment_action(jsonb, jsonb),
  public.create_custom_action(jsonb), public.update_action(uuid, uuid, jsonb), public.apply_billing_state(jsonb, uuid, jsonb, timestamptz),
  public.review_deletion_request(uuid, text, uuid, text, jsonb, timestamptz), public.delete_account(uuid, timestamptz),
  public.grant_platform_admin(uuid, uuid, jsonb, timestamptz), public.revoke_platform_admin(uuid, jsonb, timestamptz),
  public.list_audit(uuid, boolean, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.create_organization(jsonb, jsonb, jsonb), public.claim_analysis(jsonb),
  public.redeem_claim_ticket(text, timestamptz), public.accept_invitation(uuid, uuid, jsonb, timestamptz),
  public.set_member_role(uuid, uuid, text, uuid, text, jsonb, timestamptz), public.remove_member(uuid, uuid, uuid, text, jsonb, timestamptz),
  public.revoke_invitation(uuid, uuid, text, jsonb, timestamptz), public.upsert_assessment_action(jsonb, jsonb),
  public.create_custom_action(jsonb), public.update_action(uuid, uuid, jsonb), public.apply_billing_state(jsonb, uuid, jsonb, timestamptz),
  public.review_deletion_request(uuid, text, uuid, text, jsonb, timestamptz), public.delete_account(uuid, timestamptz),
  public.grant_platform_admin(uuid, uuid, jsonb, timestamptz), public.revoke_platform_admin(uuid, jsonb, timestamptz),
  public.list_audit(uuid, boolean, bigint, integer)
  to service_role;

commit;
