#!/bin/sh
# First boot of pilot's Postgres: the roles Supabase provides and the migrations expect (anon, authenticated,
# service_role), and PostgREST's login role, which switches to service_role on the back's JWT. Then the migrations.
set -eu
psql -v ON_ERROR_STOP=1 --username postgres --dbname arca \
  -v authenticator_password="$AUTHENTICATOR_PASSWORD" <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator noinherit login password :'authenticator_password';
grant anon, authenticated, service_role to authenticator;
SQL
arca-migrate
