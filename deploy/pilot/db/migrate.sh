#!/bin/sh
# Applies, in order and once each, the migrations of supabase/migrations that pilot's database has not seen. Runs at first
# boot (00-roles.sh) and on every pilot deploy (activate.sh), so a new migration reaches pilot with the image that brings it.
set -eu
run() { psql -v ON_ERROR_STOP=1 --username postgres --dbname arca "$@"; }
run -q -c 'create table if not exists public._pilot_migrations (name text primary key, applied_at timestamptz not null default now())'
run -q -c 'revoke all on public._pilot_migrations from anon, authenticated'
for file in $(ls /migrations/*.sql | sort); do
  name=$(basename "$file")
  if [ "$(run -tAq -c "select 1 from public._pilot_migrations where name = '$name'")" = "1" ]; then continue; fi
  echo "pilot migration: $name"
  run -q --single-transaction -f "$file" -c "insert into public._pilot_migrations(name) values ('$name')"
done
# PostgREST rereads the schema, so new tables and functions are served at once.
run -q -c "notify pgrst, 'reload schema'"
