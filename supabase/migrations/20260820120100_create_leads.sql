-- Captura de leads: se crea apenas alguien deja su email, antes de cualquier cuenta.
-- El funnel status permite retargetear a quien vio su pre-score y no completó el assessment.

create type lead_source as enum ('direct', 'broker_invite', 'broker_lead');

create type lead_status as enum (
  'email_captured',
  'pre_scored',
  'assessment_started',
  'assessment_completed',
  'broker_requested',
  'checkout_started',
  'converted',
  'lost'
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  domain text not null,
  firm_id uuid references firms (id) on delete set null,
  source lead_source not null default 'direct',
  status lead_status not null default 'email_captured',
  pre_score integer check (pre_score is null or pre_score between 0 and 100),
  composite_score integer check (composite_score is null or composite_score between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);

-- Un mismo email puede evaluar varias firmas, pero no dos veces la misma.
create unique index leads_email_domain_idx on leads (lower(email), lower(domain));
create index leads_status_idx on leads (status);

-- TODO RLS: cerrada a anon en Fase 1; las políticas por broker llegan con el dashboard.
alter table leads enable row level security;
