-- Resultado de Capa 1. `signals` queda como columna de primer nivel para poder consultarla,
-- y `layer1_result` guarda el contrato completo que devuelve el pipeline.

create type scan_confidence as enum ('HIGH', 'MEDIUM', 'LOW');

create type score_tier as enum ('FORTRESS', 'FORTIFIED', 'GUARDED', 'EXPOSED', 'CRITICAL');

create table scans (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firms (id) on delete cascade,
  pre_score integer not null check (pre_score between 0 and 100),
  tier score_tier not null,
  confidence scan_confidence not null,
  signals jsonb not null default '[]'::jsonb,
  -- El Layer1Result completo: lo consumen GET /scan y la selección adaptativa de preguntas.
  layer1_result jsonb not null,
  created_at timestamptz not null default now()
);

create index scans_firm_id_created_at_idx on scans (firm_id, created_at desc);

-- TODO RLS: cerrada a anon en Fase 1. El acceso público va por session_token, no por RLS.
alter table scans enable row level security;
