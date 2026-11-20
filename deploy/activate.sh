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
