#!/usr/bin/env bash
# Runs on the host from the payload extracted out of the image being deployed.
set -euo pipefail

image="${1:?usage: activate.sh IMAGE REGION PAYLOAD_DIR}"
region="${2:?usage: activate.sh IMAGE REGION PAYLOAD_DIR}"
payload="${3:?usage: activate.sh IMAGE REGION PAYLOAD_DIR}"
root=/opt/arca

# Render the environment first, into a temporary file: a missing or malformed secret stops the
# deploy before anything running is touched.
rendered="$(mktemp "$root/.env.XXXXXX")"
trap 'rm -f "$rendered"' EXIT
chmod 0600 "$rendered"
aws ssm get-parameters-by-path --region "$region" --path /arca/prod --recursive --with-decryption --output json \
  | python3 "$payload/render-env.py" "$payload/production.env" "$image" > "$rendered"

install -d -m 0755 "$root/deploy"
install -m 0644 "$payload/compose.yaml" "$root/compose.yaml"
install -m 0644 "$payload/Caddyfile" "$root/deploy/Caddyfile"
mv -f "$rendered" "$root/.env.demo"
trap - EXIT

cd "$root"
docker compose --env-file .env.demo config --quiet
docker compose --env-file .env.demo up --detach --remove-orphans --wait --wait-timeout 180
docker compose --env-file .env.demo exec -T api node -e \
  "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Every image stays in ECR, so a rollback pulls it again. Keeping them here only fills the disk.
docker image prune --all --force >/dev/null

echo "Deployed $image"
