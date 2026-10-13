-- Layer 2 stores a reproducible assessment and append-only answer audit trail.
-- All mutations go through service-role-only RPCs so answers and events commit together.
begin;

create table public.assessments (
  id text primary key check (length(id) > 0),
  scan_id text not null unique references public.scans(scan_id) on delete restrict,
  revision integer not null default 0 check (revision >= 0),
  status text not null check (status in ('PLANNING','READY','IN_PROGRESS','COMPLETED','FAILED','EXPIRED')),
  bank_version text not null check (length(bank_version) > 0),
  bank_snapshot jsonb not null check (bank_snapshot <> 'null'::jsonb),
  layer1_snapshot jsonb not null check (layer1_snapshot <> 'null'::jsonb),
  evidence_snapshot jsonb not null check (evidence_snapshot <> 'null'::jsonb),
  planner text not null check (planner in ('rules','agent')),
  planner_model text,
  prompt_version text,
  plan jsonb,
  rendered jsonb not null default '[]'::jsonb check (jsonb_typeof(rendered) = 'array'),
  answers jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  answer_write_count integer not null default 0 check (answer_write_count between 0 and 1000),
  result jsonb,
  attested_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint assessment_expiry_after_creation check (expires_at > created_at),
  constraint completed_assessment_has_result check (status <> 'COMPLETED' or
    (plan is not null and result is not null and result <> 'null'::jsonb
      and attested_at is not null and completed_at is not null))
);
create index assessments_stale_planning_idx on public.assessments(updated_at) where status = 'PLANNING';
create index assessments_expiry_idx on public.assessments(expires_at)
  where status in ('PLANNING','READY','IN_PROGRESS');

create table public.assessment_answer_events (
  id bigserial primary key,
  assessment_id text not null references public.assessments(id) on delete restrict,
  question_id text not null check (length(question_id) > 0),
  answer jsonb,
  kind text not null check (kind in ('saved','invalidated')),
  suggested boolean not null default false,
  rendered jsonb not null check (jsonb_typeof(rendered) = 'object'),
  created_at timestamptz not null default now(),
  constraint assessment_event_answer_kind check (
    (kind = 'saved' and answer is not null and jsonb_typeof(answer) = 'object') or
    (kind = 'invalidated' and answer is null))
);
create index assessment_answer_events_assessment_idx on public.assessment_answer_events(assessment_id, id);

-- Protect historical inputs and already displayed text even against accidental direct SQL.
create function public.guard_assessment_history() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  item jsonb;
  rendered_ids text[] := array[]::text[];
  position integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'Assessment history cannot be deleted';
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'COMPLETED' then
      raise exception 'Completed assessments are immutable';
    end if;
    if new.id is distinct from old.id or new.scan_id is distinct from old.scan_id
      or new.bank_version is distinct from old.bank_version
      or new.bank_snapshot is distinct from old.bank_snapshot
      or new.layer1_snapshot is distinct from old.layer1_snapshot
      or new.evidence_snapshot is distinct from old.evidence_snapshot
      or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
      raise exception 'Assessment snapshots and identity are immutable';
    end if;
    if old.plan is not null and (new.plan is distinct from old.plan
      or new.planner is distinct from old.planner or new.planner_model is distinct from old.planner_model
      or new.prompt_version is distinct from old.prompt_version) then
      raise exception 'Assessment plan and planner provenance are immutable';
    end if;
    if jsonb_typeof(new.rendered) is distinct from 'array'
      or jsonb_array_length(new.rendered) < jsonb_array_length(old.rendered) then
      raise exception 'Rendered questions must preserve the immutable prefix';
    end if;
    for position in 0..jsonb_array_length(old.rendered) - 1 loop
      if new.rendered -> position is distinct from old.rendered -> position then
        raise exception 'Rendered questions must preserve the immutable prefix';
      end if;
    end loop;
  end if;
  if jsonb_typeof(new.rendered) is distinct from 'array' then
    raise exception 'Rendered questions must be an array';
  end if;
  for item in select value from jsonb_array_elements(new.rendered) loop
    if jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item -> 'id') is distinct from 'string'
      or length(item ->> 'id') = 0 or (item ->> 'id') = any(rendered_ids) then
      raise exception 'Rendered questions require unique nonempty ids';
    end if;
    rendered_ids := array_append(rendered_ids, item ->> 'id');
  end loop;
  return new;
end;
$$;
create trigger assessments_preserve_history before insert or update or delete on public.assessments
  for each row execute function public.guard_assessment_history();

create function public.guard_assessment_answer_event() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Assessment answer events are append-only';
end;
$$;
create trigger assessment_answer_events_preserve_history before update or delete on public.assessment_answer_events
  for each row execute function public.guard_assessment_answer_event();

create function public.create_assessment(p_record jsonb) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  stored public.assessments%rowtype;
begin
  if jsonb_typeof(p_record) is distinct from 'object' then
    raise exception 'Assessment record must be an object';
  end if;
  -- A transaction-scoped lock makes competing creates return the same committed row,
  -- including when the original assessment is already terminal. There is one ever per scan.
  perform pg_advisory_xact_lock(hashtextextended('assessment:' || (p_record ->> 'scan_id'), 0));
  select * into stored from public.assessments where scan_id = p_record ->> 'scan_id';
  if found then return to_jsonb(stored); end if;
  if coalesce((p_record ->> 'revision')::integer, 0) <> 0
    or coalesce((p_record ->> 'answer_write_count')::integer, 0) <> 0
    or coalesce(p_record -> 'answers', '{}'::jsonb) <> '{}'::jsonb then
    raise exception 'New assessments must have no answer history';
  end if;
  insert into public.assessments(id, scan_id, status, bank_version, bank_snapshot, layer1_snapshot,
    evidence_snapshot, planner, planner_model, prompt_version, plan, rendered, answers,
    result, attested_at, created_at, expires_at, updated_at, completed_at)
  values (p_record ->> 'id', p_record ->> 'scan_id', p_record ->> 'status', p_record ->> 'bank_version',
    p_record -> 'bank_snapshot', p_record -> 'layer1_snapshot', p_record -> 'evidence_snapshot',
    p_record ->> 'planner', p_record ->> 'planner_model', p_record ->> 'prompt_version',
    nullif(p_record -> 'plan', 'null'::jsonb), coalesce(p_record -> 'rendered', '[]'::jsonb), '{}'::jsonb,
    nullif(p_record -> 'result', 'null'::jsonb), (p_record ->> 'attested_at')::timestamptz,
    coalesce((p_record ->> 'created_at')::timestamptz, now()), (p_record ->> 'expires_at')::timestamptz,
    coalesce((p_record ->> 'updated_at')::timestamptz, now()), (p_record ->> 'completed_at')::timestamptz)
  on conflict (scan_id) do nothing returning * into stored;
  if not found then select * into stored from public.assessments where scan_id = p_record ->> 'scan_id'; end if;
  return to_jsonb(stored);
end;
$$;

create function public.update_assessment(p_id text, p_revision integer, p_update jsonb, p_events jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  stored public.assessments%rowtype;
  candidate public.assessments%rowtype;
  event jsonb;
  question text;
  event_questions text[] := array[]::text[];
  displayed jsonb;
  saved_count integer := 0;
  expected_count integer;
begin
  -- Lock before checking revision: two callers with the same revision cannot both win.
  select * into stored from public.assessments where id = p_id for update;
  if not found or stored.revision is distinct from p_revision or stored.status in ('COMPLETED','EXPIRED','FAILED') then return null; end if;
  if jsonb_typeof(p_update) is distinct from 'object' or jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'Assessment update must be an object and events an array';
  end if;
  if exists (select 1 from jsonb_object_keys(p_update) as field(name) where name not in
    ('status','planner','planner_model','prompt_version','plan','rendered','answers','result',
     'attested_at','updated_at','completed_at','answer_write_count')) then
    raise exception 'Assessment update contains an immutable or unknown field';
  end if;
  candidate := jsonb_populate_record(stored, p_update);
  if jsonb_typeof(candidate.answers) is distinct from 'object'
    or jsonb_typeof(candidate.rendered) is distinct from 'array' then
    raise exception 'Assessment answers must be an object and rendered an array';
  end if;
  for event in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(event) is distinct from 'object'
      or jsonb_typeof(event -> 'question_id') is distinct from 'string'
      or coalesce(length(event ->> 'question_id'), 0) = 0
      or (event ->> 'question_id') = any(event_questions)
      or coalesce(event ->> 'kind', '') not in ('saved','invalidated') then
      raise exception 'Assessment events require unique question ids and a valid kind';
    end if;
    question := event ->> 'question_id';
    event_questions := array_append(event_questions, question);
    select value into displayed from jsonb_array_elements(candidate.rendered) where value ->> 'id' = question;
    if not found or event -> 'rendered' is distinct from displayed then
      raise exception 'Assessment event must retain the exact rendered question';
    end if;
    if event ->> 'kind' = 'saved' then
      saved_count := saved_count + 1;
      if jsonb_typeof(event -> 'answer') is distinct from 'object'
        or candidate.answers -> question is distinct from event -> 'answer' then
        raise exception 'Saved event must match the current answer';
      end if;
    elsif candidate.answers ? question or nullif(event -> 'answer', 'null'::jsonb) is not null
      or not (stored.answers ? question) then
      raise exception 'Invalidation must remove an existing answer';
    end if;
  end loop;
  for question in select jsonb_object_keys(stored.answers || candidate.answers) loop
    if stored.answers -> question is distinct from candidate.answers -> question
      and not (question = any(event_questions)) then
      raise exception 'Every answer change requires an audit event';
    end if;
  end loop;
  expected_count := stored.answer_write_count + saved_count;
  if saved_count > 1 or expected_count > 1000 or (p_update ? 'answer_write_count'
    and candidate.answer_write_count is distinct from expected_count) then
    raise exception 'Assessment answer write limit or counter violated';
  end if;
  update public.assessments set status = candidate.status, planner = candidate.planner,
    planner_model = candidate.planner_model, prompt_version = candidate.prompt_version,
    plan = candidate.plan, rendered = candidate.rendered, answers = candidate.answers,
    result = candidate.result, attested_at = candidate.attested_at,
    updated_at = case when p_update ? 'updated_at' then candidate.updated_at else now() end, completed_at = candidate.completed_at,
    answer_write_count = expected_count, revision = stored.revision + 1
    where id = p_id returning * into stored;
  insert into public.assessment_answer_events(assessment_id, question_id, answer, kind, suggested, rendered, created_at)
    select p_id, value ->> 'question_id', nullif(value -> 'answer', 'null'::jsonb), value ->> 'kind',
      coalesce((value ->> 'suggested')::boolean, false), value -> 'rendered',
      coalesce((value ->> 'created_at')::timestamptz, now()) from jsonb_array_elements(p_events);
  return to_jsonb(stored);
end;
$$;

alter table public.assessments enable row level security;
alter table public.assessment_answer_events enable row level security;
revoke all on public.assessments, public.assessment_answer_events from public, anon, authenticated, service_role;
revoke all on sequence public.assessment_answer_events_id_seq from public, anon, authenticated, service_role;
grant select on public.assessments, public.assessment_answer_events to service_role;
revoke all on function public.guard_assessment_history(), public.guard_assessment_answer_event() from public, anon, authenticated;
revoke all on function public.create_assessment(jsonb), public.update_assessment(text,integer,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.create_assessment(jsonb), public.update_assessment(text,integer,jsonb,jsonb) to service_role;

commit;
