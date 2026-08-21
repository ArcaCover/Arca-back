-- Catálogo de firmas de abogados. El dominio es la identidad natural: un scan siempre
-- empieza por un dominio, así que es la clave de deduplicación.

create type practice_area as enum (
  'criminal_defense',
  'immigration',
  'personal_injury',
  'family_law',
  'commercial_litigation',
  'employment_law',
  'corporate_ma',
  'real_estate',
  'tax_regulatory'
);

create table firms (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique,
  name text,
  city text,
  state char(2),
  attorneys_count integer check (attorneys_count is null or attorneys_count > 0),
  practice_areas practice_area[] not null default '{}',
  primary_practice practice_area,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index firms_state_primary_practice_idx on firms (state, primary_practice);

-- TODO RLS: en Fase 1 el backend usa SERVICE_ROLE_KEY y la tabla queda cerrada a anon.
-- Antes de exponer el anon key hay que definir políticas por broker/organización.
alter table firms enable row level security;
