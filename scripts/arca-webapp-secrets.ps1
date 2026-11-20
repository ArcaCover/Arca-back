<#
.SYNOPSIS
  Stores the secrets of the ARCA webapp (Stripe and Resend) in AWS SSM Parameter Store. Windows PowerShell 5.1,
  arca-deploy profile.

.DESCRIPTION
  .\scripts\arca-webapp-secrets.ps1                        Asks for every secret (Stripe in test mode) and stores them under /arca/prod.
  .\scripts\arca-webapp-secrets.ps1 -Mode live             The same with live Stripe keys, for the launch.
  .\scripts\arca-webapp-secrets.ps1 -Only RESEND_API_KEY   Asks only for the named secret(s).
  .\scripts\arca-webapp-secrets.ps1 -Status                Says which webapp secrets are stored, by name only.

  Each value is typed by you, hidden, checked against the prefix of its kind (and, for Stripe, its mode), sent straight
  to SSM as a SecureString and never printed or written to disk. Pressing Enter on an empty prompt keeps the stored value.

  STRIPE_SECRET_KEY      a restricted key (rk_test_ / rk_live_) with the permissions of DN-13 section 6.7; a full secret
                         key (sk_) is accepted but warned about.
  STRIPE_WEBHOOK_SECRET  the whsec_ of the endpoint https://api.arcacover.com/billing/webhook in the Stripe dashboard
                         (Developers -> Webhooks), in the same mode as the key.
  RESEND_API_KEY         a Resend API key (re_), from the Resend dashboard (API Keys). "Sending access" limited to the
                         arcacover.com domain is enough; it has no test or live mode.

  Storing them changes nothing on its own: the API reads them only when deploy/production.env has WEBAPP_ENABLED=true
  (RESEND_API_KEY only with EMAIL_PROVIDER=resend), and deploy/render-env.py then refuses to start without them. A Stripe
  test key in production also needs STRIPE_ALLOW_TEST_MODE=true in production.env (DN-13 section 6.7).

  This script was called arca-billing-secrets.ps1; that name still works and forwards here.
#>
param(
  [ValidateSet('test', 'live')][string]$Mode = 'test',
  [ValidateSet('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY')][string[]]$Only,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'

$AwsProfile = if ($env:ARCA_AWS_PROFILE) { $env:ARCA_AWS_PROFILE } else { 'arca-deploy' }
$Region = 'us-east-1'
$SecretsPath = '/arca/prod'
$AllNames = @('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY')
$Names = if ($Only) { @($AllNames | Where-Object { $Only -contains $_ }) } else { $AllNames }

function Fail([string]$Text) { throw $Text }

function Invoke-Aws([string[]]$Arguments) {
  $output = & aws --profile $AwsProfile --region $Region @Arguments 2>&1
  [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Output = ($output | Out-String).Trim() }
}

function Get-StoredNames {
  $result = Invoke-Aws @('ssm', 'describe-parameters', '--parameter-filters', "Key=Path,Values=$SecretsPath",
    '--query', 'Parameters[].Name', '--output', 'text')
  if (-not $result.Ok) { Fail "Could not list $SecretsPath with profile $AwsProfile" }
  @($result.Output -split '\s+' | Where-Object { $_ } | ForEach-Object { $_.Substring($_.LastIndexOf('/') + 1) })
}

function ConvertFrom-Secure([System.Security.SecureString]$Secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Test-Value([string]$Name, [string]$Value) {
  switch ($Name) {
    'STRIPE_SECRET_KEY' {
      if ($Value -cnotmatch "^(rk|sk)_$($Mode)_[A-Za-z0-9]+$") { return "expected a $Mode key starting with rk_$($Mode)_ (or sk_$($Mode)_)" }
      if ($Value -like 'sk_*') { Write-Host "  Note: this is a full secret key. A restricted key (rk_) is safer." -ForegroundColor Yellow }
    }
    'STRIPE_WEBHOOK_SECRET' {
      if ($Value -cnotmatch '^whsec_[A-Za-z0-9]+$') { return 'expected a webhook signing secret starting with whsec_' }
    }
    'RESEND_API_KEY' {
      # The same check as the API's (apps/api/src/config/env.ts), so a key stored here is never refused at start.
      if ($Value -cnotmatch '^re_[A-Za-z0-9_-]+$') { return 'expected a Resend API key starting with re_' }
    }
  }
  ''
}

function Set-Secret([string]$Name, [string]$Value) {
  $result = Invoke-Aws @('ssm', 'put-parameter', '--name', "$SecretsPath/$Name", '--type', 'SecureString',
    '--overwrite', '--value', $Value, '--output', 'text')
  if (-not $result.Ok) { Fail "Could not store $Name" }
}

$identity = Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text')
if (-not $identity.Ok) { Fail "Profile $AwsProfile cannot sign in. Configure it with: aws configure --profile $AwsProfile" }

$stored = Get-StoredNames
if ($Status) {
  foreach ($name in $AllNames) { Write-Host ("  {0}: {1}" -f $name, $(if ($stored -contains $name) { 'stored' } else { 'missing' })) }
  return
}

Write-Host ""
Write-Host "==> Webapp secrets (Stripe in $Mode mode) under $SecretsPath" -ForegroundColor Cyan
foreach ($name in $Names) {
  $hint = if ($stored -contains $name) { 'stored; Enter keeps it' } else { 'missing' }
  while ($true) {
    $value = (ConvertFrom-Secure (Read-Host "  $name ($hint, hidden)" -AsSecureString)).Trim()
    if (-not $value) {
      if ($stored -contains $name) { Write-Host "  ${name}: kept"; break }
      Write-Host "  $name is missing; type it or press Ctrl+C to stop." -ForegroundColor Yellow
      continue
    }
    $problem = Test-Value $name $value
    if ($problem) { Write-Host "  ${name}: $problem. Try again." -ForegroundColor Yellow; $value = $null; continue }
    Set-Secret $name $value
    $value = $null
    Write-Host "  ${name}: stored"
    break
  }
}

Write-Host ""
Write-Host "Done. Nothing changes until deploy/production.env has WEBAPP_ENABLED=true and the API is deployed." -ForegroundColor Cyan
if ($Mode -eq 'test' -and ($Names -contains 'STRIPE_SECRET_KEY')) {
  Write-Host "A Stripe test key in production also needs STRIPE_ALLOW_TEST_MODE=true in deploy/production.env." -ForegroundColor Cyan
}
