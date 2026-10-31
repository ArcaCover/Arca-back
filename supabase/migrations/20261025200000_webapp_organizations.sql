-- The private webapp (DN-10): accounts, organizations, roles, billing and the platform admin.
-- User ids are plain uuids with no foreign key to auth.users: only the backend writes, with the service role,
-- after verifying the Supabase JWT, and the schema stays applicable without Supabase Auth (PGlite tests).
-- Not applied to any database yet (DN-10 §10).
begin;

create table public.profiles (
  user_id uuid primary key,
  email text not null check (length(email) > 0),
  full_name text,
  last_org_id uuid,
  created_at timestamptz not null default now()
);

-- Organizations are never deleted physically (legal implications): approving a deletion sets deleted_at.
-- billing_status is moved only by the billing webhook.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  domain text,
  billing_status text not null default 'pending_payment'
    check (billing_status in ('pending_payment','active','past_due','canceled')),
  deleted_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
alter table public.profiles add constraint profiles_last_org_fk
  foreign key (last_org_id) references public.organizations(id) on delete restrict;

create table public.memberships (
  org_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null,
  role text not null check (role in ('owner','admin','member','viewer')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id);

-- Only the hash of the token is stored. An invitation can never grant ownership.
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  email text not null check (length(email) > 0),
  role text not null check (role in ('admin','member','viewer')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by uuid not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitation_expiry_after_creation check (expires_at > created_at)
);
-- Expiry is not part of the predicate (an index cannot call now()): the backend revokes an expired invitation
-- before inviting the same email again.
create unique index invitations_pending_email_idx on public.invitations(org_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- A scan belongs to at most one organization, claimed once (the UNIQUE is what makes the claim race-safe).
create table public.org_analyses (
  org_id uuid not null references public.organizations(id) on delete restrict,
  scan_id text not null unique references public.scans(scan_id) on delete restrict,
  assessment_id text references public.assessments(id) on delete restrict,
  claimed_by uuid not null,
  claimed_at timestamptz not null default now()
);
create index org_analyses_org_idx on public.org_analyses(org_id, claimed_at);

-- The bridge from the anonymous funnel to the signup: id_hash is the hash of the one-use claim id.
create table public.claim_tickets (
  id_hash text primary key check (id_hash ~ '^[a-f0-9]{64}$'),
  scan_id text not null references public.scans(scan_id) on delete restrict,
  email text not null check (length(email) > 0),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- The price lives only here: the checkout reads it, so changing a row changes what is charged.
create table public.plans (
  code text primary key check (length(code) > 0),
  name text not null check (length(btrim(name)) > 0),
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null check (currency ~ '^[a-z]{3}$'),
  "interval" text not null check ("interval" in ('month','year')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Written only by the billing webhook.
create table public.subscriptions (
  org_id uuid primary key references public.organizations(id) on delete restrict,
  plan_code text not null references public.plans(code) on delete restrict,
  customer_id text,
  subscription_id text,
  status text not null check (status in ('pending_payment','active','past_due','canceled')),
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Idempotency: a repeated billing event id is never processed twice.
create table public.stripe_events (
  id text primary key check (length(id) > 0),
  type text not null check (length(type) > 0),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  requested_by uuid not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);
create unique index deletion_requests_pending_idx on public.deletion_requests(org_id) where status = 'pending';

-- ARCA staff, separate from the organization roles. granted_by is null when a script grants it.
create table public.platform_admins (
  user_id uuid primary key,
  granted_by uuid,
  created_at timestamptz not null default now()
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  org_id uuid references public.organizations(id) on delete restrict,
  action text not null check (length(action) > 0),
  target text,
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now()
);
create index audit_log_org_idx on public.audit_log(org_id, created_at);

-- An organization always keeps an owner: refuse the UPDATE or DELETE that would remove the last one.
create function public.guard_last_owner() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.role = 'owner' and not (tg_op = 'UPDATE' and new.role = 'owner'
    and new.org_id = old.org_id and new.user_id = old.user_id) then
    -- Serialize owner changes of one organization, so two sessions cannot each remove "the other" owner.
    perform pg_advisory_xact_lock(hashtextextended('owners:' || old.org_id::text, 0));
    if not exists (select 1 from public.memberships
      where org_id = old.org_id and role = 'owner' and user_id <> old.user_id) then
      raise exception 'An organization must keep at least one owner';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger memberships_keep_an_owner before update or delete on public.memberships
  for each row execute function public.guard_last_owner();

create function public.guard_audit_log() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'The audit log is append-only';
end;
$$;
create trigger audit_log_preserve_history before update or delete on public.audit_log
  for each row execute function public.guard_audit_log();

-- Example prices, to be changed in this table (never in code): the checkout charges whatever the row says.
insert into public.plans (code, name, amount_cents, currency, "interval") values
  ('monthly', 'Monthly (example price)', 49900, 'usd', 'month'),
  ('annual', 'Annual (example price)', 499000, 'usd', 'year');

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.org_analyses enable row level security;
alter table public.claim_tickets enable row level security;
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;
alter table public.deletion_requests enable row level security;
alter table public.platform_admins enable row level security;
alter table public.audit_log enable row level security;

-- Only the backend, with the service role, touches these tables. service_role is revoked first so that
-- default privileges cannot leave it more than granted below (audit_log gets no update or delete).
revoke all on public.profiles, public.organizations, public.memberships, public.invitations, public.org_analyses,
  public.claim_tickets, public.plans, public.subscriptions, public.stripe_events, public.deletion_requests,
  public.platform_admins, public.audit_log from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.profiles, public.organizations, public.memberships, public.invitations,
  public.org_analyses, public.claim_tickets, public.plans, public.subscriptions, public.stripe_events,
  public.deletion_requests, public.platform_admins to service_role;
grant select, insert on public.audit_log to service_role;
revoke all on function public.guard_last_owner(), public.guard_audit_log() from public, anon, authenticated;

commit;
