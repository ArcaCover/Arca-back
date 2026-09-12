# AWS demo runbook

This runbook deploys one EC2 host with Docker Compose and Caddy. It creates no load balancer.

## 1. Prerequisites

- Docker Desktop running locally.
- AWS CLI v2.32 or newer and an authenticated short-lived session.
- Node.js 22 and npm.
- Control of the final demo hostname.
- A clean, committed `main` checkout.

Set the deployment coordinates in PowerShell. Replace the hostname if a different DNS name is chosen:

```powershell
$AwsRegion = 'us-east-1'
$DemoHostname = 'api.arcacover.com'
$AwsAccount = aws sts get-caller-identity --query Account --output text
$env:CDK_DEFAULT_ACCOUNT = $AwsAccount
$env:CDK_DEFAULT_REGION = $AwsRegion
```

## 2. Verify locally

These checks use mock sources and do not call Apify, Supabase or OpenAI:

```powershell
npm ci
npm run build
npm test
npm run test:container
npm audit --omit=dev
npm run build --prefix infra/aws
npm run synth --prefix infra/aws -- -c demoHostname=$DemoHostname
```

## 3. Bootstrap and provision AWS

Bootstrap once per account and region, inspect the diff, then deploy:

```powershell
npx --prefix infra/aws cdk bootstrap "aws://$AwsAccount/$AwsRegion"
npm run diff --prefix infra/aws -- -c demoHostname=$DemoHostname
npm run deploy --prefix infra/aws -- -c demoHostname=$DemoHostname --require-approval broadening
```

If the hostname is in Route 53, add both contexts so CDK creates the A record:

```powershell
npm run deploy --prefix infra/aws -- `
  -c demoHostname=$DemoHostname `
  -c hostedZoneId=Z1234567890 `
  -c hostedZoneName=arcacover.com `
  --require-approval broadening
```

Otherwise, create an external DNS A record from `$DemoHostname` to the `ElasticIpAddress` stack output.

Record these stack outputs:

- `EcrRepositoryUri`
- `InstanceId`
- `ElasticIpAddress`
- `DemoUrl`

## 4. Configure runtime values

Open the EC2 instance in AWS Systems Manager → Session Manager. No SSH port or key pair is used.

Inside the session:

```bash
sudo cp /opt/arca/.env.demo.example /opt/arca/.env.demo
sudo chmod 0600 /opt/arca/.env.demo
sudoedit /opt/arca/.env.demo
```

Set the real Supabase and Apify values, generate a unique session secret, set the final hostname and
leave `WEBSITE_EVIDENCE_PROVIDER=rules`. Do not paste these values into tickets, logs or SSM Run Command.

Generate the documentation basic-auth hash in the same session and set `DOCS_AUTH_USER` and
`DOCS_AUTH_HASH`. The command prompts for the password; it is never passed as an argument:

```bash
docker run --rm -it caddy:2.10.2-alpine caddy hash-password
```

Compose interpolates every value in this file, so each `$` of the hash must be doubled when it is
written to `.env.demo`: `$2a$14$...` is stored as `$$2a$$14$$...`. An unescaped hash reaches Caddy
truncated and leaves the documentation open, so `deploy-image.sh` refuses to deploy without the
escaped form.

## 5. Publish the current commit

From the clean local checkout:

```powershell
$RepositoryUri = '<EcrRepositoryUri output>'
$InstanceId = '<InstanceId output>'
./deploy/publish-demo.ps1 `
  -Region $AwsRegion `
  -RepositoryUri $RepositoryUri `
  -InstanceId $InstanceId
```

The script refuses a dirty tree or a tag different from the current Git SHA.

## 6. Non-paid HTTPS smoke checks

After DNS and TLS are active:

```powershell
Invoke-RestMethod "https://$DemoHostname/health"
$DocsAuth = Get-Credential -UserName arca -Message "Documentation basic auth"
Invoke-WebRequest "https://$DemoHostname/openapi.json" -Authentication Basic -Credential $DocsAuth -UseBasicParsing
Invoke-WebRequest "https://$DemoHostname/docs" -Authentication Basic -Credential $DocsAuth -UseBasicParsing
```

Confirm that `/docs` and `/openapi.json` return HTTP 401 without credentials, and that requests sent to
the Elastic IP instead of the hostname never reach the API.

Verify that an invalid body returns HTTP 400 and an unauthenticated scan read returns HTTP 401. Do not
submit the final valid live scan until its external cost is explicitly approved.

## 7. Final paid test

Use one pre-approved public law-firm domain. Record scan ID, terminal status, source durations, each
Apify run ID, returned count, accepted count and reported cost. Repeat the same domain once to prove the
24-hour cache without another provider run.

## 8. Rollback

Activate a previous image already retained in ECR:

```powershell
./deploy/activate-demo.ps1 `
  -Region $AwsRegion `
  -RepositoryUri $RepositoryUri `
  -InstanceId $InstanceId `
  -ImageTag '<previous healthy Git SHA>'
```

Then confirm `https://$DemoHostname/health` and inspect container status through Session Manager.
