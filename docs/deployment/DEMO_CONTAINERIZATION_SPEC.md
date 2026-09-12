# ARCA Layer 1 — AWS demo deployment specification

Status: implemented locally; AWS provisioning and the final paid smoke scan remain pending.

## 1. Objective

Run the Layer 1 API as a reproducible container on a small AWS demo host, expose HTTPS and retain
Supabase as managed persistence. OpenAI remains disabled. The deployment must not make port 8080,
AWS credentials, Supabase credentials or Apify credentials public.

## 2. Architecture

```text
Internet
  |
  | TCP 80/443, UDP 443
  v
Elastic IP -> EC2 t3.medium (Amazon Linux 2023)
                 |
                 +-- Caddy container: TLS and security headers
                 +-- ARCA API container: private Docker network :8080
                 +-- SSM: administration without public SSH
                 `-- ECR: immutable commit-SHA images
                        |
                        +-- Supabase HTTPS
                        +-- Apify HTTPS
                        `-- public law-firm websites
```

There is deliberately no load balancer, NAT Gateway, public SSH port or multi-instance service. This
is a single-host demo and accepts a short interruption during deployment. Layer 1 currently executes
jobs and rate limits in process, so one replica is also the correct consistency boundary.

## 3. Implemented artifacts

- Multi-stage, non-root production `Dockerfile` with pinned Node 22 base digest and Playwright Chromium.
- `compose.yaml` with private API networking, health checks, read-only filesystems, bounded logs and
  pinned Caddy image digest.
- `deploy/Caddyfile` for automatic HTTPS, compression, a 32 KiB request limit, security headers and
  basic auth on the documentation routes.
- `.env.demo.example` with placeholders only.
- `scripts/container-smoke.mjs` for local mock-only container validation.
- `infra/aws` CDK application for ECR, one-AZ VPC, EC2, encrypted gp3 disk, Elastic IP, security
  group, SSM role and optional Route 53 record.
- `deploy/publish-demo.ps1` for test, immutable build, ECR push and activation through SSM.
- `deploy/activate-demo.ps1` for deployment or rollback to an existing SHA.
- `deploy/deploy-image.sh` installed on the host by EC2 user data.
- `docs/deployment/AWS_DEMO_RUNBOOK.md` for provisioning, secrets, release, verification and rollback.

## 4. Container requirements

- Runtime contains compiled output, production dependencies and Chromium; TypeScript sources, tests,
  docs, local env files and Git history are excluded.
- The API runs as the unprivileged `node` user with `dumb-init` as PID 1.
- Compose drops Linux capabilities, enables `no-new-privileges`, uses a read-only root filesystem,
  allocates 512 MiB shared memory for Chromium and mounts only bounded temporary storage.
- The API has no host port. Caddy is the only public container.
- Both services use Docker log rotation: five files of 10 MiB each.

## 5. AWS resources

The `ArcaDemoStack` creates:

- One retained, AES-256-encrypted ECR repository with scan-on-push and a 20-image lifecycle limit.
- One `10.42.0.0/24` VPC and one public `/27` subnet; no paid NAT Gateway.
- One `t3.medium` x86_64 Amazon Linux 2023 instance with 20 GiB encrypted gp3 storage and IMDSv2.
- One Elastic IP.
- One security group allowing only TCP 80/443 and UDP 443 inbound.
- One EC2 role with the managed SSM core policy and pull-only permission to this ECR repository.
- An optional Route 53 A record when both hosted-zone context values are supplied.

The stack uses termination protection. ECR is retained if the stack is removed.

## 6. Runtime configuration

Required values in `/opt/arca/.env.demo`:

| Variable | Value |
| --- | --- |
| `ARCA_IMAGE` | Immutable ECR URI tagged with the deployed Git SHA |
| `DEMO_HOSTNAME` | Public DNS hostname pointing to the Elastic IP |
| `DOCS_AUTH_USER` | Basic-auth user for `/docs` and `/openapi.json` |
| `DOCS_AUTH_HASH` | bcrypt hash produced by `caddy hash-password` |
| `NODE_ENV` | `production` |
| `PORT` | `8080` |
| `SOURCE_MODE` | `live` |
| `STORAGE_BACKEND` | `supabase` |
| `WEBSITE_EVIDENCE_PROVIDER` | `rules` |
| `SUPABASE_URL` | Managed Supabase URL |
| `SUPABASE_SECRET_KEY` | Backend-only secret key |
| `SESSION_TOKEN_SECRET` | Random value of at least 32 characters |
| `APIFY_API_TOKEN` | Backend-only Apify token |
| `CORS_ALLOWED_ORIGINS` | `https://arcacover.com,http://localhost:3000` |
| `TRUST_PROXY_HOPS` | `1`, because Caddy is the only ingress |
| `MAX_DIRECTORY_TARGETS` | `2` |
| `MAX_APIFY_CONCURRENCY` | `2` |

Each paid provider run requests at most ten records. A scan starts no more than four directory runs.

Secrets are not passed through CDK, user data, container layers or SSM command arguments. They are
entered interactively on the host through Session Manager and the file is mode `0600` owned by root.

## 7. Release and rollback

Every release must come from a clean, committed checkout. The image tag must equal `git rev-parse HEAD`.
The release script runs `npm ci`, TypeScript build, the full test suite and a linux/amd64 image build,
then pushes the image and activates it over SSM. Activation validates Compose, waits for health and
retains older immutable ECR images for rollback.

Rollback calls `activate-demo.ps1` with a prior healthy SHA. It never rebuilds or retags that image.

## 8. Acceptance

Before the first public demo:

1. The local container smoke test passes without external APIs.
2. CDK synth and diff are reviewed before deploy.
3. DNS resolves to the Elastic IP and Caddy provisions HTTPS.
4. `/health`, request validation and scan-token authorization pass over HTTPS; `/docs` and
   `/openapi.json` return HTTP 401 without credentials and render with them.
5. Supabase persistence and cache pass using the deployed API.
6. One pre-approved live law-firm scan completes with run IDs, duration and reported cost recorded.
7. Repeating that domain proves the 24-hour cache without paid provider calls.
8. A restart proves stale RUNNING scans recover to a terminal state.

Item 6 is explicitly gated on user confirmation because it makes paid external calls.

## 9. Remaining external inputs

- An authenticated AWS CLI session with rights to bootstrap and deploy CDK.
- AWS region; `us-east-1` is the operational default for this demo.
- Final demo hostname and control of its DNS zone.
- Runtime secret values entered by the user after the instance exists.
