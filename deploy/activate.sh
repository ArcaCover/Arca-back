#!/usr/bin/env bash
# Runs on the host from the payload extracted out of the image being deployed.
set -euo pipefail

image="${1:?usage: activate.sh IMAGE REGION PAYLOAD_DIR}"
region="${2:?usage: activate.sh IMAGE REGION PAYLOAD_DIR}"
payload="${3:?usage: activate.sh IMAGE REGION PAYLOAD_DIR}"
root=/opt/arca

# Production's Caddy and the pilot API meet on this network (deploy/pilot/compose.pilot.yaml). Created once, kept.
docker network inspect arca-edge >/dev/null 2>&1 || docker network create arca-edge >/dev/null

# An image built from the pilot branch (Dockerfile ARCA_TARGET=pilot) activates pilot, its own Compose project, and
# never touches production's containers or its .env.demo.
if [ "$(cat "$payload/target" 2>/dev/null || echo production)" = "pilot" ]; then
  pilot="$root/pilot"
  install -d -m 0755 "$pilot" "$pilot/db"
  rendered="$(mktemp "$pilot/.env.XXXXXX")"
  trap 'rm -f "$rendered"' EXIT
  chmod 0600 "$rendered"
  aws ssm get-parameters-by-path --region "$region" --path /arca/pilot --recursive --with-decryption --output json     | python3 "$payload/render-env.py" "$payload/pilot/pilot.env" "$image" > "$rendered"
  install -m 0644 "$payload/pilot/compose.pilot.yaml" "$pilot/compose.pilot.yaml"
  install -m 0644 "$payload/pilot/rest.Caddyfile" "$pilot/rest.Caddyfile"
  install -m 0755 "$payload/pilot/db/00-roles.sh" "$pilot/db/00-roles.sh"
  install -m 0755 "$payload/pilot/db/migrate.sh" "$pilot/db/migrate.sh"
  rm -rf "$pilot/migrations" && cp -r "$payload/pilot/migrations" "$pilot/migrations"
  mv -f "$rendered" "$pilot/.env.pilot"
  trap - EXIT
  cd "$pilot"
  docker compose -f compose.pilot.yaml --env-file .env.pilot config --quiet
  docker compose -f compose.pilot.yaml --env-file .env.pilot up --detach --remove-orphans --wait --wait-timeout 240 db
  # A new migration in this image reaches pilot's database before the API that needs it starts.
  docker compose -f compose.pilot.yaml --env-file .env.pilot exec -T db arca-migrate
  docker compose -f compose.pilot.yaml --env-file .env.pilot up --detach --remove-orphans --wait --wait-timeout 240
  docker image prune --all --force >/dev/null
  echo "Deployed pilot $image"
  exit 0
fi

# Render the environment first, into a temporary file: a missing or malformed secret stops the
# deploy before anything running is touched.
rendered="$(mktemp "$root/.env.XXXXXX")"
trap 'rm -f "$rendered"' EXIT
chmod 0600 "$rendered"
aws ssm get-parameters-by-path --region "$region" --path /arca/prod --recursive --with-decryption --output json \
  | python3 "$payload/render-env.py" "$payload/production.env" "$image" > "$rendered"
# The region the CloudWatch logging override interpolates (compose.cloudwatch.yaml).
printf 'ARCA_AWS_REGION=%s\n' "$region" >> "$rendered"

install -d -m 0755 "$root/deploy"
install -m 0644 "$payload/compose.yaml" "$root/compose.yaml"
install -m 0644 "$payload/Caddyfile" "$root/deploy/Caddyfile"
# The API's logs go to CloudWatch Logs (DN-13 §9.5) once the stack has their log group (cdk deploy of infra/aws). Until the
# host can reach it they stay in json-file, so a deploy never waits on the stack. The override is named on the command line,
# never merged by default: a rollback to an image from before it runs plain compose.yaml.
files=(-f compose.yaml)
if aws logs describe-log-streams --region "$region" --log-group-name /arca/api --limit 1 >/dev/null 2>&1; then
  install -m 0644 "$payload/compose.cloudwatch.yaml" "$root/compose.cloudwatch.yaml"
  files+=(-f compose.cloudwatch.yaml)
  echo "API logs: CloudWatch Logs group /arca/api"
else
  rm -f "$root/compose.cloudwatch.yaml"
  echo "API logs: kept on the host, the log group /arca/api is not reachable yet (cdk deploy of infra/aws)" >&2
fi
mv -f "$rendered" "$root/.env.demo"
trap - EXIT

cd "$root"
docker compose "${files[@]}" --env-file .env.demo config --quiet
docker compose "${files[@]}" --env-file .env.demo up --detach --remove-orphans --wait --wait-timeout 180
docker compose "${files[@]}" --env-file .env.demo exec -T api node -e \
  "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Every image stays in ECR, so a rollback pulls it again. Keeping them here only fills the disk.
docker image prune --all --force >/dev/null

echo "Deployed $image"
