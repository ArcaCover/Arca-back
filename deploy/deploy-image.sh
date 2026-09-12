#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: deploy-image.sh ECR_IMAGE_URI AWS_REGION}"
region="${2:?usage: deploy-image.sh ECR_IMAGE_URI AWS_REGION}"

if [[ ! "$image" =~ ^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/arca-demo:[0-9a-f]{7,40}$ ]]; then
  echo "Refusing a non-ECR or mutable image reference" >&2
  exit 2
fi
if [[ ! -s /opt/arca/.env.demo ]]; then
  echo "/opt/arca/.env.demo is empty; configure runtime values first" >&2
  exit 3
fi

registry="${image%%/*}"
aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry" >/dev/null

sed -i "s|^ARCA_IMAGE=.*$|ARCA_IMAGE=$image|" /opt/arca/.env.demo
cd /opt/arca
docker compose --env-file .env.demo config --quiet
docker compose --env-file .env.demo pull api
docker compose --env-file .env.demo up --detach --remove-orphans --wait --wait-timeout 120
docker compose --env-file .env.demo exec -T api node -e \
  "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

echo "Deployed $image"
