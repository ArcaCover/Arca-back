#!/usr/bin/env bash
# One entry point for the ARCA API on AWS. Run it from Git Bash with the arca-deploy profile.
#
#   scripts/arca-aws.sh up        store missing secrets, create or update the stack, connect GitHub,
#                                 and start the app deploy when the workflow is on main
#   scripts/arca-aws.sh down      delete the stack and the image repository (asks for confirmation)
#   scripts/arca-aws.sh down --secrets   also delete the secrets under /arca/prod
#   scripts/arca-aws.sh status    stack, secrets present (names only), DNS and health
#
# Nothing sensitive lives in this file. Secret values are typed by you, hidden, when a secret is
# missing, or generated (the session secret, the /docs password hash). They go straight to SSM
# Parameter Store and are never printed or written to disk.
set -euo pipefail

PROFILE="${ARCA_AWS_PROFILE:-arca-deploy}"
REGION=us-east-1
ACCOUNT=194633188202
STACK=ArcaDemoStack
REPOSITORY=arca-demo
GITHUB_REPO=ArcaCover/Arca-back
WORKFLOW=deploy-api.yml
SECRETS=/arca/prod
HOSTNAME_API=api.arcacover.com
CADDY_IMAGE='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
DEPLOY_ROLE="arn:aws:iam::$ACCOUNT:role/cdk-hnb659fds-deploy-role-$ACCOUNT-$REGION"
EXEC_ROLE="arn:aws:iam::$ACCOUNT:role/cdk-hnb659fds-cfn-exec-role-$ACCOUNT-$REGION"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
infra="$root/infra/aws"
# Not committed: the repository is public.
emails_file="$infra/.alert-emails"

# Git Bash would rewrite /arca/prod into a Windows path before the AWS CLI sees it.
export MSYS_NO_PATHCONV=1

# Messages go to stderr, so functions whose output is captured never mix them into a value.
say() { printf '\n\033[1m==> %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
# The Windows AWS CLI ends text output with CRLF; strip it so values compare cleanly.
awsp() { aws --profile "$PROFILE" --region "$REGION" "$@" | tr -d '\r'; }

preflight() {
  for tool in aws node npm; do command -v "$tool" >/dev/null || die "Missing $tool on PATH"; done
  local account
  account="$(awsp sts get-caller-identity --query Account --output text 2>/dev/null)" \
    || die "Profile $PROFILE cannot sign in. Configure it with: aws configure --profile $PROFILE"
  [ "$account" = "$ACCOUNT" ] || die "Profile $PROFILE points at account $account, not $ACCOUNT"
}

alert_emails() {
  local emails="${ARCA_ALERT_EMAILS:-}"
  [ -n "$emails" ] || { [ -s "$emails_file" ] && emails="$(tr -d '\r\n ' < "$emails_file")"; }
  if [ -z "$emails" ]; then
    read -rp "Alert emails, comma separated: " emails
    [ -n "$emails" ] || die "At least one alert email is required"
    printf '%s\n' "$emails" > "$emails_file"
  fi
  printf '%s' "$emails"
}

setting() { sed -n "s/^$1=//p" "$root/deploy/production.env" | tail -1 | tr -d '\r'; }

required_secrets() {
  echo SUPABASE_URL SUPABASE_SECRET_KEY SESSION_TOKEN_SECRET APIFY_API_TOKEN DOCS_AUTH_HASH
  local provider endpoint
  provider="$(setting WEBSITE_EVIDENCE_PROVIDER)"; endpoint="$(setting SIGNAL_LLM_ENDPOINT)"
  if [ "$provider" = openai ] || { [ "$provider" = nvidia ] && [ "$endpoint" = openai ]; }; then echo OPENAI_API_KEY; fi
  if [ "$provider" = nvidia ] && [ "${endpoint:-nvidia}" = nvidia ]; then echo NVIDIA_NIM_API_KEY; fi
}

stored_secrets() {
  awsp ssm describe-parameters --parameter-filters "Key=Path,Values=$SECRETS" \
    --query 'Parameters[].Name' --output text | tr '\t' '\n' | sed 's#.*/##'
}

put_secret() {
  awsp ssm put-parameter --name "$SECRETS/$1" --type SecureString --overwrite --value "$2" >/dev/null
}

docs_hash() {
  local password confirm hash=''
  if docker info >/dev/null 2>&1; then
    read -rsp "Choose the password for /docs: " password; echo >&2
    read -rsp "Repeat it: " confirm; echo >&2
    [ "$password" = "$confirm" ] || die "The passwords differ"
    hash="$(printf '%s\n' "$password" | docker run --rm -i "$CADDY_IMAGE" caddy hash-password 2>/dev/null | tr -d '\r' | tail -1)"
    unset password confirm
  else
    warn "Docker is not running, so the /docs password cannot be hashed here."
    warn "Start Docker Desktop and run this again, or paste a hash from: caddy hash-password"
    read -rsp "bcrypt hash: " hash; echo >&2
  fi
  [[ "$hash" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || die "That is not a bcrypt hash"
  printf '%s' "$hash"
}

ensure_secrets() {
  say "Secrets under $SECRETS"
  local stored name value
  stored="$(stored_secrets)"
  for name in $(required_secrets); do
    if grep -qx "$name" <<< "$stored"; then echo "  $name: stored"; continue; fi
    case "$name" in
      SESSION_TOKEN_SECRET) value="$(openssl rand -hex 32)"; echo "  $name: generated" ;;
      DOCS_AUTH_HASH) value="$(docs_hash)"; echo "  $name: hashed" ;;
      *) read -rsp "  $name (hidden): " value; echo; [ -n "$value" ] || die "$name cannot be empty" ;;
    esac
    put_secret "$name" "$value"
    unset value
  done
}

output() {
  awsp cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

stack_status() {
  awsp cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE
}

deploy_stack() {
  say "Infrastructure ($STACK)"
  local emails
  emails="$(alert_emails)"
  (cd "$infra" && { [ -d node_modules ] || npm ci; } \
    && npx cdk deploy --profile "$PROFILE" -c "alertEmails=$emails" --require-approval broadening)
}

resolved_ip() {
  nslookup "$HOSTNAME_API" 1.1.1.1 2>/dev/null | tr -d '\r' | awk '/^Name:/ {found=1} found && /^Address/ {print $2}' | head -1
}

check_dns() {
  say "DNS"
  local ip resolved
  ip="$(output ElasticIpAddress)"; resolved="$(resolved_ip)"
  if [ "$resolved" = "$ip" ]; then echo "  $HOSTNAME_API -> $ip"; return 0; fi
  warn "  $HOSTNAME_API resolves to '${resolved:-nothing}', expected $ip."
  warn "  In Vercel, add an A record: name 'api', value $ip. The app deploy's health check waits for it."
  return 1
}

connect_github() {
  say "GitHub"
  command -v gh >/dev/null || { warn "  gh not found: set the repository variable AWS_DEPLOY_ROLE_ARN by hand"; return 1; }
  local role current
  role="$(output GithubDeployRoleArn)"
  current="$(gh variable get AWS_DEPLOY_ROLE_ARN -R "$GITHUB_REPO" 2>/dev/null | tr -d '\r' || true)"
  if [ "$current" != "$role" ]; then gh variable set AWS_DEPLOY_ROLE_ARN -R "$GITHUB_REPO" --body "$role"; fi
  echo "  AWS_DEPLOY_ROLE_ARN = $role"
}

deploy_app() {
  say "App"
  if ! gh workflow view "$WORKFLOW" -R "$GITHUB_REPO" >/dev/null 2>&1; then
    warn "  $WORKFLOW is not on main yet. Merge the deployment branch and it deploys on its own."
    return 0
  fi
  gh workflow run "$WORKFLOW" -R "$GITHUB_REPO" --ref main
  sleep 5
  local run
  run="$(gh run list -R "$GITHUB_REPO" --workflow "$WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId')"
  gh run watch "$run" -R "$GITHUB_REPO" --exit-status
}

up() {
  preflight
  ensure_secrets
  deploy_stack
  local dns_ok=0; check_dns || dns_ok=1
  connect_github && { [ "$dns_ok" = 0 ] || warn "  Deploying anyway; the health check fails until DNS resolves."; deploy_app; }
  say "Done. Confirm the AWS subscription email each alert address received."
}

down() {
  local with_secrets="${1:-}"
  preflight
  warn "This deletes $STACK (server, IP, network, roles, alarms) and every image in $REPOSITORY."
  [ "$with_secrets" = --secrets ] && warn "It also deletes every secret under $SECRETS."
  local answer; read -rp "Type $STACK to continue: " answer
  [ "$answer" = "$STACK" ] || die "Cancelled"

  if [ "$(stack_status)" != NONE ]; then
    say "Deleting $STACK"
    # Termination protection and deletion go through the CDK deploy role, which CloudFormation
    # executes with the scoped ArcaCdkExecution policy. The temporary credentials stay in this shell.
    local credentials key secret token
    credentials="$(awsp sts assume-role --role-arn "$DEPLOY_ROLE" --role-session-name arca-down \
      --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
    read -r key secret token <<< "$credentials"
    (
      export AWS_ACCESS_KEY_ID="$key" AWS_SECRET_ACCESS_KEY="$secret" AWS_SESSION_TOKEN="$token"
      unset AWS_PROFILE
      aws --region "$REGION" cloudformation update-termination-protection --no-enable-termination-protection \
        --stack-name "$STACK" >/dev/null
      aws --region "$REGION" cloudformation delete-stack --stack-name "$STACK" --role-arn "$EXEC_ROLE"
      aws --region "$REGION" cloudformation wait stack-delete-complete --stack-name "$STACK"
    )
    unset credentials key secret token
    echo "  deleted"
  fi

  # The stack keeps the repository on purpose, so a stack mistake never loses rollback images.
  if awsp ecr describe-repositories --repository-names "$REPOSITORY" >/dev/null 2>&1; then
    say "Deleting the $REPOSITORY repository and its images"
    awsp ecr delete-repository --repository-name "$REPOSITORY" --force >/dev/null
  fi

  if [ "$with_secrets" = --secrets ]; then
    say "Deleting secrets"
    local names; names="$(stored_secrets | sed "s#^#$SECRETS/#" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    [ -n "${names// /}" ] && awsp ssm delete-parameters --names $names >/dev/null
  fi

  # Without the variable, pushes to main only run the tests instead of failing a deploy.
  if command -v gh >/dev/null && gh variable get AWS_DEPLOY_ROLE_ARN -R "$GITHUB_REPO" >/dev/null 2>&1; then
    gh variable delete AWS_DEPLOY_ROLE_ARN -R "$GITHUB_REPO"
  fi

  say "Done. Left in place: the CDKToolkit bootstrap (cents a month) and the IAM user."
  [ "$with_secrets" = --secrets ] || echo "Secrets are free and were kept; add --secrets to delete them."
}

status() {
  preflight
  say "Stack"; echo "  $STACK: $(stack_status)"
  say "Secrets present"; stored_secrets | sed 's/^/  /'
  if [ "$(stack_status)" != NONE ]; then
    echo "  instance: $(output InstanceId)  ip: $(output ElasticIpAddress)"
    check_dns || true
    say "Health"
    curl --silent --show-error --max-time 10 "https://$HOSTNAME_API/health" && echo || warn "  unreachable"
  fi
}

case "${1:-}" in
  up) up ;;
  down) down "${2:-}" ;;
  status) status ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
