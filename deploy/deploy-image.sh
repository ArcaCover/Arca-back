#!/usr/bin/env bash
# Installed on the host once, by EC2 user data. It stays deliberately small: it pulls the image
# and hands over to the activate.sh that travels inside that image, so a deploy or a rollback
# runs the compose file, Caddyfile and configuration of its own commit, and changing any of them
# never requires touching the host.
set -euo pipefail

image="${1:?usage: deploy-image.sh ECR_IMAGE_URI AWS_REGION}"
region="${2:?usage: deploy-image.sh ECR_IMAGE_URI AWS_REGION}"

if [[ ! "$image" =~ ^[0-9]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/arca-demo:[0-9a-f]{7,40}$ ]]; then
  echo "Refusing a non-ECR or mutable image reference" >&2
  exit 2
fi

registry="${image%%/*}"
aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry" >/dev/null
docker pull --quiet "$image"

payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
container="$(docker create "$image")"
docker cp "$container:/app/deploy-payload/." "$payload/"
docker rm "$container" >/dev/null

bash "$payload/activate.sh" "$image" "$region" "$payload"
