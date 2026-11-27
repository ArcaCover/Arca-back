# AWS runbook

One EC2 host runs the API and Caddy with Docker Compose. GitHub Actions deploys every push to
`main` that touches the API (`.github/workflows/deploy-api.yml`): it tests, builds one image tagged
with the commit SHA, pushes it to ECR and activates it on the host through SSM. There is no load
balancer, no NAT Gateway and no SSH.

| Piece | Where |
| --- | --- |
| Infrastructure | `infra/aws` (CDK stack `ArcaDemoStack`, account `194633188202`, `us-east-1`) |
| Non-secret configuration | `deploy/production.env`, shipped inside each image |
| Secrets | SSM Parameter Store, one SecureString per variable under `/arca/prod/` |
| Host bootstrap | `deploy/deploy-image.sh`, installed once by EC2 user data |
| Activation | `deploy/activate.sh` and `deploy/render-env.py`, shipped inside each image |

Because the compose file, Caddyfile and configuration travel inside the image, a rollback restores
all of them together with the code.

## The short way

`scripts/arca-aws.ps1` (Windows PowerShell 5.1) wraps steps 2 to 6 below. It holds no secret: when
one is missing under `/arca/prod` it asks for the value hidden, or generates it (the session
secret, and the `/docs` password hash when Docker Desktop is running), and sends it straight to
Parameter Store.

```powershell
.\scripts\arca-aws.ps1 up              # secrets, stack, GitHub variable, app deploy
.\scripts\arca-aws.ps1 status          # stack, secret names, DNS, health
.\scripts\arca-aws.ps1 down            # delete the stack and the image repository
.\scripts\arca-aws.ps1 down -Secrets   # also delete the secrets
```

`up` stops to show IAM and security-group changes before applying them. The first run asks for
the alert addresses and keeps them in `infra/aws/.alert-emails`, which is not committed. The DNS
record in Vercel stays manual; `up` and `status` say which IP it must point to. `down` leaves the
CDK bootstrap and the IAM user in place. Set `ARCA_AWS_PROFILE` to use a profile other than
`arca-deploy`.

The steps below are what the script does, for doing them by hand.

Commands below use Git Bash. `arca-deploy` is the CLI profile of the least-privilege IAM user
`arca_deploy_only`; only step 1 needs an administrator.

## 1. Bootstrap CDK (once, administrator)

**Done on 2026-09-29** (`CDKToolkit`, bootstrap version 32, execution policy `ArcaCdkExecution`).
Repeat only in a new account or region.

CDK's default bootstrap gives CloudFormation `AdministratorAccess`, which would let anyone who can
deploy a CDK stack create anything in the account. Bootstrap with the scoped policy instead:

```bash
aws iam create-policy --policy-name ArcaCdkExecution \
  --policy-document file://infra/aws/cdk-execution-policy.json
cd infra/aws && npm ci
npx cdk bootstrap aws://194633188202/us-east-1 \
  --cloudformation-execution-policies arn:aws:iam::194633188202:policy/ArcaCdkExecution
```

If the stack later needs a new kind of resource, extend `cdk-execution-policy.json` and update the
policy's version with an administrator before deploying.

## 2. Store the secrets

Each value is typed without echo, so it stays out of the shell history:

```bash
put() { read -rsp "$1: " value && echo && aws ssm put-parameter --profile arca-deploy --region us-east-1 \
  --name "/arca/prod/$1" --type SecureString --overwrite --value "$value" > /dev/null; unset value; }
put SUPABASE_URL
put SUPABASE_SECRET_KEY
put APIFY_API_TOKEN
put OPENAI_API_KEY
```

The session secret and the docs password hash are generated, not typed:

```bash
aws ssm put-parameter --profile arca-deploy --region us-east-1 --name /arca/prod/SESSION_TOKEN_SECRET \
  --type SecureString --overwrite --value "$(openssl rand -hex 32)" > /dev/null
put DOCS_AUTH_HASH   # paste the output of: docker run --rm -it caddy:2.10.2-alpine caddy hash-password
```

Store the hash exactly as printed. `render-env.py` escapes every `$` for Compose, and refuses to
deploy if a required secret is missing or the hash is not bcrypt. Production runs the agentic
website extraction through OpenAI (`WEBSITE_EVIDENCE_PROVIDER=agentic` in `deploy/production.env`),
so `OPENAI_API_KEY` is required too.

## 3. Create or update the infrastructure

```bash
cd infra/aws
npx cdk diff --profile arca-deploy --method template -c alertEmails=neoprotecciones@gmail.com,jesusdel1611@gmail.com
npx cdk deploy --profile arca-deploy -c alertEmails=neoprotecciones@gmail.com,jesusdel1611@gmail.com \
  --require-approval broadening
```

`alertEmails` is required on every deploy, because leaving it out would remove the subscriptions.
Each address receives an AWS email and must confirm it before alerts arrive.

Record the outputs `ElasticIpAddress` and `GithubDeployRoleArn`.

## 4. DNS

In Vercel, add an `A` record for `api.arcacover.com` pointing to `ElasticIpAddress`. Caddy obtains
the TLS certificate on its own once the name resolves.

## 5. Connect GitHub

```bash
gh variable set AWS_DEPLOY_ROLE_ARN -R ArcaCover/Arca-back --body '<GithubDeployRoleArn>'
```

Until this variable exists the workflow tests but skips the deploy. The role can only be assumed
by workflows running on `main` of `ArcaCover/Arca-back`.

## 6. Deploy, roll back, change a secret

- **Deploy:** merge to `main`. Actions → *Deploy API* shows the run.
- **Roll back:** Actions → *Deploy API* → *Run workflow*, with `image_tag` set to the full SHA of an
  earlier healthy commit. The image is not rebuilt. ECR keeps the last 20.
- **Change a secret:** `put NAME` as in step 2, then run the workflow with `image_tag` set to the
  SHA currently deployed. Secrets are read at activation, never baked into an image.

A deploy restarts the API container. A scan in flight at that moment is lost and ends `FAILED`
once the new process recovers it; the visitor can start it again, and the website and directory
caches make the retry cheaper.

## 7. Checks after the first deploy

```bash
curl -fsS https://api.arcacover.com/health
curl -s -o /dev/null -w '%{http_code}\n' https://api.arcacover.com/docs          # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.arcacover.com/scan  # 400
```

Do not submit a real scan until its external cost (Apify, the LLM provider) is approved.

## 8. On the host

```bash
aws ssm start-session --profile arca-deploy --region us-east-1 --target <InstanceId>
sudo docker compose -f /opt/arca/compose.yaml --env-file /opt/arca/.env.demo ps
sudo docker compose -f /opt/arca/compose.yaml --env-file /opt/arca/.env.demo logs --tail 200 api
```

Session Manager needs the AWS CLI Session Manager plugin installed locally.

If GitHub is unavailable, the same activation can be sent by hand:

```bash
aws ssm send-command --profile arca-deploy --region us-east-1 --instance-ids <InstanceId> \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/opt/arca/deploy/deploy-image.sh <EcrRepositoryUri>:<sha> us-east-1"]'
```

## 9. API logs and billing alarms

The stack keeps the API container's logs in the CloudWatch Logs group `/arca/api` (three months) and
counts the payment lines of DN-13 §9.5 with metric filters in the namespace `ARCA/Billing`: a failed
or partial daily reconciliation, a reconciliation mismatch, a webhook that failed or came from the
other Stripe mode, a duplicate subscription, a dispute, an event with no organization, a deletion
whose subscription could not be canceled, and a start refused by the real webapp. One such line in
five minutes raises its alarm on the SNS topic `BillingAlertTopicArn` (an output of the stack),
which is separate from the host alerts and has **no subscription** until someone adds one. Nothing
here touches AWS billing, budgets or cost settings.

The stack change is not deployed by a merge to `main`; it needs, in this order:

1. **An administrator** updates the scoped execution policy, which now allows the `/arca/api` log
   group (step 1). IAM keeps at most five versions of a policy; delete the oldest first if needed.

   ```bash
   aws iam create-policy-version --policy-arn arn:aws:iam::194633188202:policy/ArcaCdkExecution \
     --policy-document file://infra/aws/cdk-execution-policy.json --set-as-default
   ```

2. `cdk diff` and `cdk deploy` as in step 3. They add the log group, the host's permission to
   write to it, the filters, the alarms and the topic; the host is not replaced, because its image
   is pinned (`HOST_AMI_ID` in `infra/aws/lib/arca-demo-stack.ts`). Before that pin, the stack asked
   for the latest Amazon Linux 2023 image at every deploy, and `cdk diff` on 2026-11-27 showed it
   would replace the host. If `cdk diff` ever shows `AWS::EC2::Instance ... replace`, stop: a
   replacement takes the API down, deletes the host's disk and needs the image deployed again.
3. The **next** activation of the API (a merge to `main`, or the workflow with `image_tag` set to
   the SHA already deployed) finds the log group and passes `deploy/compose.cloudwatch.yaml` to
   compose: from then on the API logs to CloudWatch. Until the group is reachable, `activate.sh`
   keeps the logs on the host as before and says so in the deploy output, so a merge before
   `cdk deploy` is harmless.

To receive the billing alarms, subscribe an address and confirm the email AWS sends. In the console:
SNS → Topics → the topic of `BillingAlertTopicArn` → Create subscription → Email. Or with an
administrator profile (`arca-deploy` cannot subscribe):

```bash
aws sns subscribe --region us-east-1 --topic-arn <BillingAlertTopicArn> \
  --protocol email --notification-endpoint founder@example.com
```

A subscription made this way is not part of the template, so later deploys keep it. The logs are
in the console (CloudWatch → Log groups → `/arca/api`) or, with a profile allowed to read them,
`aws logs tail /arca/api --region us-east-1 --since 1h --follow`; `docker compose logs` on the
host keeps working too.
