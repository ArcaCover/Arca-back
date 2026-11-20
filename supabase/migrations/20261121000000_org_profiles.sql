-- The pre-checkout (DN-13 §19): the firm profile a new customer gives before paying, kept beside its organization, and Checkout
-- embedded in ARCA's page. Additive: one new table, one new function, and checkout_sessions learns which kind of Checkout each
-- session is (an embedded session has no page of its own, so its url is null). No scan table changes. Like every webapp
-- migration, the back alone reads and writes it, with the service role (DN-13 §5.5).
begin;

-- Who signed up and which firm pays: written once, with the organization, by create_organization_with_profile. The Stripe customer
-- is created from it (name, address, phone and the EIN as a us_ein tax id), so Checkout asks for none of it again.
create table public.org_profiles (
  org_id uuid primary key references public.organizations(id) on delete restrict,
  contact_name text not null check (char_length(contact_name) between 1 and 120),
  contact_role text not null check (contact_role in ('managing_partner','partner','office_manager','other')),
  contact_phone text check (contact_phone ~ '^\+?[0-9 ().-]+$' and char_length(contact_phone) <= 20),
  legal_name text not null check (char_length(legal_name) between 1 and 200),
  ein text check (ein ~ '^[0-9]{2}-[0-9]{7}$'),
  address_line1 text not null check (char_length(address_line1) between 1 and 200),
  address_city text not null check (char_length(address_city) between 1 and 100),
  address_state text not null check (address_state ~ '^[A-Z]{2}$'),
  address_postal_code text not null check (address_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  address_country text not null default 'US' check (address_country = 'US'),
  attorney_range text not null check (attorney_range in ('1','2-5','6-20','21-50','50+')),
  practice_states text[] not null check (cardinality(practice_states) between 1 and 51
    and array_position(practice_states, null) is null),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hosted (a Stripe page with its url, as before) or embedded (mounted in ARCA's page with a client secret, no url). The sessions
-- stored before this migration were all hosted.
alter table public.checkout_sessions
  add column ui_mode text not null default 'hosted' check (ui_mode in ('hosted','embedded')),
  alter column url drop not null,
  add constraint checkout_sessions_url_of_hosted check (ui_mode = 'embedded' or url is not null);

-- The organization, its first owner, the claimed analysis and the firm profile, together or not at all. create_organization does
-- the first three, with its errors (webapp_conflict:scan_claimed, webapp_invalid:organization); a null profile adds nothing.
create function public.create_organization_with_profile(p_org jsonb, p_owner jsonb, p_analysis jsonb, p_profile jsonb) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org_id uuid := (p_org->>'id')::uuid;
  v_profile jsonb := nullif(p_profile, 'null'::jsonb);
begin
  if v_profile is not null and (v_profile->>'org_id')::uuid is distinct from v_org_id then
    raise exception 'webapp_invalid:organization' using errcode = 'P0001';
  end if;
  perform public.create_organization(p_org, p_owner, p_analysis);
  if v_profile is not null then
    insert into public.org_profiles (org_id, contact_name, contact_role, contact_phone, legal_name, ein, address_line1, address_city,
      address_state, address_postal_code, address_country, attorney_range, practice_states, created_by, created_at, updated_at)
    values (v_org_id, v_profile->>'contact_name', v_profile->>'contact_role', v_profile->>'contact_phone', v_profile->>'legal_name',
      v_profile->>'ein', v_profile->>'address_line1', v_profile->>'address_city', v_profile->>'address_state',
      v_profile->>'address_postal_code', coalesce(v_profile->>'address_country', 'US'), v_profile->>'attorney_range',
      array(select jsonb_array_elements_text(v_profile->'practice_states')), (v_profile->>'created_by')::uuid,
      (v_profile->>'created_at')::timestamptz, (v_profile->>'updated_at')::timestamptz);
  end if;
end;
$$;

-- §5.5: no policies, no grants to the client roles; only the back, with the service role.
alter table public.org_profiles enable row level security;
revoke all on public.org_profiles from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.org_profiles to service_role;

revoke all on function public.create_organization_with_profile(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_organization_with_profile(jsonb, jsonb, jsonb, jsonb) to service_role;

commit;
