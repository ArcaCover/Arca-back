# ARCA Layer 1 — AWS demo deployment specification

Status: implemented and deployable from GitHub; AWS provisioning and the final paid smoke scan remain pending.

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
  The runtime image also carries the deployment payload in `/app/deploy-payload`.
- `compose.yaml` with private API networking, health checks, read-only filesystems, bounded logs and
  pinned Caddy image digest.
- `deploy/Caddyfile` for automatic HTTPS, compression, a 32 KiB request limit, security headers and
  basic auth on the documentation routes.
- `deploy/production.env` with the non-secret runtime configuration.
- `deploy/deploy-image.sh`, the only file installed on the host by EC2 user data: it pulls an image
  and runs the payload's `deploy/activate.sh`, which renders the env file with `deploy/render-env.py`.
- `scripts/container-smoke.mjs` for local mock-only container validation.
- `infra/aws` CDK application, and `infra/aws/cdk-execution-policy.json` for a scoped bootstrap.
- `.github/workflows/deploy-api.yml` for test, build, push, activation and rollback.
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
- One EC2 role with the managed SSM core policy and pull-only permission to this ECR repository, plus read access to `/arca/prod` parameters.
- An optional Route 53 A record when both hosted-zone context values are supplied.
- A GitHub OIDC provider and the `arca-github-deploy` role, assumable only from `main` of
  `ArcaCover/Arca-back`: push to this ECR repository and `SendCommand` to this instance only.
- An SNS topic with the alert addresses, and two status-check alarms that recover (hardware) or
  reboot (operating system) the instance and notify the topic.

The stack uses termination protection. ECR is retained if the stack is removed.

## 6. Runtime configuration

The host's `/opt/arca/.env.demo` is generated at every activation and never edited by hand. It merges:

- `deploy/production.env` from the image being deployed: hostname, docs user, source and storage
  modes, CORS origins, Apify limits, TTLs and timeouts.
- Every SecureString under `/arca/prod/` in SSM Parameter Store, named after its variable:
  `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_TOKEN_SECRET`, `APIFY_API_TOKEN`, `DOCS_AUTH_HASH`,
  and `OPENAI_API_KEY` only if the configuration switches to an OpenAI extraction. Production
  uses `WEBSITE_EVIDENCE_PROVIDER=rules`; NVIDIA NIM is not used.
- `ARCA_IMAGE`, the immutable image being activated.

A variable defined in both places, a missing required secret or a non-bcrypt docs hash stops the
activation before anything running is touched. Secrets never pass through CDK, user data, image
layers, GitHub or SSM command arguments.

## 7. Release and rollback

A push to `main` touching the API runs `deploy-api.yml`: `npm ci`, typecheck and the full test suite,
then a linux/amd64 build tagged with the commit SHA, a push to ECR and activation over SSM, then an
HTTPS health check. Deploys are serialized and never cancelled halfway.

Rollback runs the same workflow by hand with the SHA of an earlier image. It never rebuilds or
retags that image, and restores that commit's compose file, Caddyfile and configuration with it.

A deploy restarts the API container, so a scan in flight is lost and recovers to `FAILED`.

## 8. Acceptance

Before the first public demo:

1. The local container smoke test passes without external APIs.
2. CDK synth and diff are reviewed before deploy.
3. DNS resolves to the Elastic IP and Caddy provisions HTTPS.
4. `/health`, request validation and scan-token authorization pass over HTTPS; `/docs` and
   `/openapi.json` return HTTP 401 without credentials and render with them.
5. Supabase persistence and cache pass using the deployed API.
6. One pre-approved live law-firm scan completes with run IDs, duration and reported cost recorded.
7. Repeating that domain proves the 7-day cache without paid provider calls.
8. A restart proves stale RUNNING scans recover to a terminal state.

Item 6 is explicitly gated on user confirmation because it makes paid external calls.

## 9. Remaining external inputs

- A one-time administrator session for the scoped CDK bootstrap (runbook step 1).
- The runtime secrets, stored under `/arca/prod/` with the `arca-deploy` profile.
- The Vercel DNS record for `api.arcacover.com`, and the `AWS_DEPLOY_ROLE_ARN` repository variable.
