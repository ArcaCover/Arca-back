-- Role views (DN-11 §4.7): the action plan an organization tracks, and what the activity needs from audit_log.
-- Like the DN-10 migration, it is not applied to any database yet (DN-11 D9).
begin;

-- scan_id alone is already unique, so the pair adds no rule: it is what the composite foreign key below references.
create unique index org_analyses_org_scan_idx on public.org_analyses(org_id, scan_id);

-- An action of the assessment gets its row the first time something changes, and takes its title, detail and domain from
-- the assessment; an action the organization wrote itself carries them. assignee_user_id has no foreign key, like every
-- user id of DN-10.
create table public.org_actions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  source text not null check (source in ('assessment','custom')),
  scan_id text,
  action_key text,
  title text,
  detail text,
  domain text check (domain in ('governance','tools','oversight','data_protection','training','incident_preparedness')),
  status text not null default 'todo' check (status in ('todo','in_progress','done')),
  assignee_user_id uuid,
  due_date date,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  -- Only a scan this organization claimed has actions. A custom action has no scan, so the key is not checked for it.
  constraint org_actions_analysis_fk foreign key (org_id, scan_id) references public.org_analyses(org_id, scan_id) on delete restrict,
  constraint org_actions_source_columns check (
    (source = 'assessment' and scan_id is not null and action_key is not null and title is null and detail is null and domain is null)
    or (source = 'custom' and scan_id is null and action_key is null and title is not null)),
  constraint org_actions_lengths check (
    length(action_key) > 0 and length(btrim(title)) > 0 and length(title) <= 200 and length(detail) <= 2000)
);
-- One row per action of each plan: an upsert on this key is how the first change creates the row.
create unique index org_actions_assessment_idx on public.org_actions(org_id, scan_id, action_key) where source = 'assessment';

-- seq gives the activity a strict order and its page cursor (DN-11 §4.3). actor_kind says who acted: a member (the
-- default), `platform` for ARCA staff acting from /admin/*, or `system` for a billing event or the seed.
alter table public.audit_log
  add column seq bigint generated always as identity unique,
  add column actor_kind text not null default 'member' check (actor_kind in ('member','platform','system'));
create index audit_log_org_seq_idx on public.audit_log(org_id, seq);

alter table public.org_actions enable row level security;

-- Only the backend, with the service role, touches the table (as in DN-10).
revoke all on public.org_actions from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.org_actions to service_role;

commit;
