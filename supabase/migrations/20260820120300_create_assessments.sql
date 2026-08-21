-- Resultado de Capa 2: respuestas del cuestionario más todo lo que produjo el Score Engine.

create type underwriting_decision as enum (
  'AUTO_BIND',
  'REFERRAL',
  'REFERRAL_SENIOR',
  'DECLINE'
);

create table assessments (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references scans (id) on delete cascade,
  responses jsonb not null,
  domain_scores jsonb not null,
  composite_score integer not null check (composite_score between 0 and 100),
  tier score_tier not null,
  decision underwriting_decision not null,
  -- null cuando la firma no es cotizable (DECLINE) o requiere cotización custom.
  pricing jsonb,
  override_rules_triggered jsonb not null default '[]'::jsonb,
  action_plan jsonb not null default '[]'::jsonb,
  path_to_insurability jsonb,
  created_at timestamptz not null default now()
);

create index assessments_scan_id_idx on assessments (scan_id);

-- TODO RLS: cerrada a anon en Fase 1; las políticas por organización llegan con el dashboard.
alter table assessments enable row level security;
