<#
.SYNOPSIS
  One entry point for the ARCA API on AWS. Windows PowerShell 5.1, arca-deploy profile.

.DESCRIPTION
  .\scripts\arca-aws.ps1 up              Store missing secrets, create or update the stack, connect
                                         GitHub, and start the app deploy when the workflow is on main.
  .\scripts\arca-aws.ps1 status          Stack, secrets present (names only), DNS and health.
  .\scripts\arca-aws.ps1 down            Delete the stack and the image repository (asks first).
  .\scripts\arca-aws.ps1 down -Secrets   Also delete the secrets under /arca/prod.

  Nothing sensitive lives in this file. A missing secret is typed by you, hidden, or generated
  (the session secret, the /docs password hash). It goes straight to SSM Parameter Store and is
  never printed or written to disk.
#>
param(
  [Parameter(Position = 0)][ValidateSet('up', 'down', 'status')][string]$Command,
  [switch]$Secrets
)

$ErrorActionPreference = 'Stop'

$AwsProfile = if ($env:ARCA_AWS_PROFILE) { $env:ARCA_AWS_PROFILE } else { 'arca-deploy' }
$Region = 'us-east-1'
$Account = '194633188202'
$Stack = 'ArcaDemoStack'
$Repository = 'arca-demo'
$GithubRepo = 'ArcaCover/Arca-back'
$Workflow = 'deploy-api.yml'
$SecretsPath = '/arca/prod'
$ApiHost = 'api.arcacover.com'
$CaddyImage = 'caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
$DeployRole = "arn:aws:iam::${Account}:role/cdk-hnb659fds-deploy-role-$Account-$Region"
$ExecRole = "arn:aws:iam::${Account}:role/cdk-hnb659fds-cfn-exec-role-$Account-$Region"

$Root = Split-Path -Parent $PSScriptRoot
$Infra = Join-Path $Root 'infra\aws'
# Not committed: the repository is public.
$EmailsFile = Join-Path $Infra '.alert-emails'

function Say([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Warn([string]$Text) { Write-Host $Text -ForegroundColor Yellow }
function Fail([string]$Text) { throw $Text }

# Runs a native command. Windows PowerShell 5.1 turns redirected stderr into terminating errors,
# so the preference is relaxed around the call and the exit code decides instead.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [switch]$Quiet) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) { $output = & $Exe @Arguments 2>$null } else { $output = & $Exe @Arguments }
    $ok = $LASTEXITCODE -eq 0
  } finally { $ErrorActionPreference = $previous }
  [pscustomobject]@{ Ok = $ok; Output = (($output | Out-String).Trim()) }
}

function Invoke-Aws([string[]]$Arguments, [switch]$Quiet, [switch]$AllowFailure) {
  $result = Invoke-Native 'aws' (@('--profile', $AwsProfile, '--region', $Region) + $Arguments) -Quiet:$Quiet
  if (-not $result.Ok -and -not $AllowFailure) { Fail "aws $($Arguments[0]) $($Arguments[1]) failed" }
  $result
}

function Test-Preflight {
  foreach ($tool in 'aws', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "Missing $tool on PATH" }
  }
  $identity = Invoke-Aws @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text') -Quiet -AllowFailure
  if (-not $identity.Ok) { Fail "Profile $AwsProfile cannot sign in. Configure it with: aws configure --profile $AwsProfile" }
  if ($identity.Output -ne $Account) { Fail "Profile $AwsProfile points at account $($identity.Output), not $Account" }
}

function Get-AlertEmails {
  if ($env:ARCA_ALERT_EMAILS) { return $env:ARCA_ALERT_EMAILS }
  if (Test-Path $EmailsFile) {
    $saved = (Get-Content $EmailsFile -Raw).Trim()
    if ($saved) { return $saved }
  }
  $emails = (Read-Host 'Alert emails, comma separated').Replace(' ', '')
  if (-not $emails) { Fail 'At least one alert email is required' }
  [System.IO.File]::WriteAllText($EmailsFile, "$emails`n")
  $emails
}

function Get-Setting([string]$Name) {
  $line = Get-Content (Join-Path $Root 'deploy\production.env') | Where-Object { $_ -match "^$Name=" } | Select-Object -Last 1
  if ($line) { $line.Substring($Name.Length + 1).Trim() } else { '' }
}

function Get-RequiredSecrets {
  $names = @('SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_TOKEN_SECRET', 'APIFY_API_TOKEN', 'DOCS_AUTH_HASH')
  $provider = Get-Setting 'WEBSITE_EVIDENCE_PROVIDER'
  $endpoint = Get-Setting 'SIGNAL_LLM_ENDPOINT'
  if ($provider -eq 'openai' -or ($provider -eq 'nvidia' -and $endpoint -eq 'openai')) { $names += 'OPENAI_API_KEY' }
  if ($provider -eq 'nvidia' -and ($endpoint -eq '' -or $endpoint -eq 'nvidia')) { $names += 'NVIDIA_NIM_API_KEY' }
  $names
}

function Get-StoredSecrets {
  $result = Invoke-Aws @('ssm', 'describe-parameters', '--parameter-filters', "Key=Path,Values=$SecretsPath",
    '--query', 'Parameters[].Name', '--output', 'text')
  @($result.Output -split '\s+' | Where-Object { $_ } | ForEach-Object { $_.Substring($_.LastIndexOf('/') + 1) })
}

function ConvertFrom-Secure([System.Security.SecureString]$Secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Set-Secret([string]$Name, [string]$Value) {
  # Windows PowerShell 5.1 drops embedded double quotes from native arguments, which would store
  # a different value than the one typed. Refuse rather than corrupt it.
  if ($Value.Contains('"')) { Fail "$Name contains a double quote, which this script cannot pass safely. Store it with the AWS console." }
  $result = Invoke-Aws @('ssm', 'put-parameter', '--name', "$SecretsPath/$Name", '--type', 'SecureString',
    '--overwrite', '--value', $Value, '--output', 'text') -Quiet -AllowFailure
  if (-not $result.Ok) { Fail "Could not store $Name" }
}

function New-DocsHash {
  $docker = Invoke-Native 'docker' @('info') -Quiet
  if ($docker.Ok) {
    $password = ConvertFrom-Secure (Read-Host 'Choose the password for /docs' -AsSecureString)
    $confirm = ConvertFrom-Secure (Read-Host 'Repeat it' -AsSecureString)
    if ($password -ne $confirm) { Fail 'The passwords differ' }
    # Written through .NET so the line ends in LF only. A pipeline would send CRLF, and the stray
    # CR would become part of the hashed password.
    $start = New-Object System.Diagnostics.ProcessStartInfo 'docker', "run --rm -i $CaddyImage caddy hash-password"
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    $process.StandardInput.Write("$password`n")
    $process.StandardInput.Close()
    $hash = $process.StandardOutput.ReadToEnd().Trim()
    $process.WaitForExit()
    $password = $null; $confirm = $null
  } else {
    Warn 'Docker is not running, so the /docs password cannot be hashed here.'
    Warn 'Start Docker Desktop and run this again, or paste a hash from: caddy hash-password'
    $hash = (ConvertFrom-Secure (Read-Host 'bcrypt hash' -AsSecureString)).Trim()
  }
  if ($hash -notmatch '^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$') { Fail 'That is not a bcrypt hash' }
  $hash
}

function Initialize-Secrets {
  Say "Secrets under $SecretsPath"
  $stored = Get-StoredSecrets
  foreach ($name in Get-RequiredSecrets) {
    if ($stored -contains $name) { Write-Host "  ${name}: stored"; continue }
    switch ($name) {
      'SESSION_TOKEN_SECRET' {
        $bytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $value = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        Write-Host "  ${name}: generated"
      }
      'DOCS_AUTH_HASH' { $value = New-DocsHash; Write-Host "  ${name}: hashed" }
      default {
        $value = ConvertFrom-Secure (Read-Host "  $name (hidden)" -AsSecureString)
        if (-not $value) { Fail "$name cannot be empty" }
      }
    }
    Set-Secret $name $value
    $value = $null
  }
}

function Get-StackStatus {
  $result = Invoke-Aws @('cloudformation', 'describe-stacks', '--stack-name', $Stack,
    '--query', 'Stacks[0].StackStatus', '--output', 'text') -Quiet -AllowFailure
  if ($result.Ok) { $result.Output } else { 'NONE' }
}

function Get-Output([string]$Key) {
  (Invoke-Aws @('cloudformation', 'describe-stacks', '--stack-name', $Stack,
    '--query', "Stacks[0].Outputs[?OutputKey=='$Key'].OutputValue", '--output', 'text')).Output
}

function Deploy-Stack {
  Say "Infrastructure ($Stack)"
  $emails = Get-AlertEmails
  Push-Location $Infra
  try {
    if (-not (Test-Path 'node_modules')) { & npm ci; if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' } }
    & npx cdk deploy --profile $AwsProfile -c "alertEmails=$emails" --require-approval broadening
    if ($LASTEXITCODE -ne 0) { Fail 'cdk deploy failed or was declined' }
  } finally { Pop-Location }
}

function Test-Dns {
  Say 'DNS'
  $ip = Get-Output 'ElasticIpAddress'
  $resolved = (Resolve-DnsName -Name $ApiHost -Type A -Server 1.1.1.1 -DnsOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
  if ($resolved -eq $ip) { Write-Host "  $ApiHost -> $ip"; return $true }
  Warn "  $ApiHost resolves to '$resolved', expected $ip."
  Warn "  In Vercel, add an A record: name 'api', value $ip. The app deploy's health check waits for it."
  $false
}

function Connect-Github {
  Say 'GitHub'
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Warn '  gh not found: set the repository variable AWS_DEPLOY_ROLE_ARN by hand'; return $false }
  $role = Get-Output 'GithubDeployRoleArn'
  $current = (Invoke-Native 'gh' @('variable', 'get', 'AWS_DEPLOY_ROLE_ARN', '-R', $GithubRepo) -Quiet).Output
  if ($current -ne $role) {
    # Out-Host keeps gh's message out of this function's return value.
    & gh variable set AWS_DEPLOY_ROLE_ARN -R $GithubRepo --body $role | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail 'Could not set AWS_DEPLOY_ROLE_ARN' }
  }
  Write-Host "  AWS_DEPLOY_ROLE_ARN = $role"
  $true
}

function Deploy-App {
  Say 'App'
  if (-not (Invoke-Native 'gh' @('workflow', 'view', $Workflow, '-R', $GithubRepo) -Quiet).Ok) {
    Warn "  $Workflow is not on main yet. Merge the deployment branch and it deploys on its own."
    return
  }
  & gh workflow run $Workflow -R $GithubRepo --ref main
  if ($LASTEXITCODE -ne 0) { Fail 'Could not start the workflow' }
  Start-Sleep -Seconds 5
  $run = (Invoke-Native 'gh' @('run', 'list', '-R', $GithubRepo, '--workflow', $Workflow, '--limit', '1',
    '--json', 'databaseId', '--jq', '.[0].databaseId')).Output
  & gh run watch $run -R $GithubRepo --exit-status
  if ($LASTEXITCODE -ne 0) { Fail "The deploy run failed: gh run view $run -R $GithubRepo --log-failed" }
}

function Invoke-Up {
  Test-Preflight
  Initialize-Secrets
  Deploy-Stack
  $dnsOk = Test-Dns
  if (Connect-Github) {
    if (-not $dnsOk) { Warn '  Deploying anyway; the health check fails until DNS resolves.' }
    Deploy-App
  }
  Say 'Done. Confirm the AWS subscription email each alert address received.'
}

function Invoke-Down {
  Test-Preflight
  Warn "This deletes $Stack (server, IP, network, roles, alarms) and every image in $Repository."
  if ($Secrets) { Warn "It also deletes every secret under $SecretsPath." }
  if ((Read-Host "Type $Stack to continue") -cne $Stack) { Fail 'Cancelled' }

  if ((Get-StackStatus) -ne 'NONE') {
    Say "Deleting $Stack"
    # Termination protection and deletion go through the CDK deploy role, which CloudFormation
    # executes with the scoped ArcaCdkExecution policy. The temporary credentials live only in
    # this process's environment and are removed afterwards.
    $credentials = (Invoke-Aws @('sts', 'assume-role', '--role-arn', $DeployRole, '--role-session-name', 'arca-down',
      '--query', 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]', '--output', 'text') -Quiet).Output -split '\s+'
    $saved = @{ Id = $env:AWS_ACCESS_KEY_ID; Key = $env:AWS_SECRET_ACCESS_KEY; Token = $env:AWS_SESSION_TOKEN; Profile = $env:AWS_PROFILE }
    try {
      $env:AWS_ACCESS_KEY_ID = $credentials[0]; $env:AWS_SECRET_ACCESS_KEY = $credentials[1]; $env:AWS_SESSION_TOKEN = $credentials[2]
      Remove-Item Env:AWS_PROFILE -ErrorAction SilentlyContinue
      foreach ($step in @(
          @('cloudformation', 'update-termination-protection', '--no-enable-termination-protection', '--stack-name', $Stack),
          @('cloudformation', 'delete-stack', '--stack-name', $Stack, '--role-arn', $ExecRole),
          @('cloudformation', 'wait', 'stack-delete-complete', '--stack-name', $Stack))) {
        $result = Invoke-Native 'aws' (@('--region', $Region) + $step)
        if (-not $result.Ok) { Fail "aws $($step[1]) failed" }
      }
    } finally {
      $env:AWS_ACCESS_KEY_ID = $saved.Id; $env:AWS_SECRET_ACCESS_KEY = $saved.Key
      $env:AWS_SESSION_TOKEN = $saved.Token; $env:AWS_PROFILE = $saved.Profile
      $credentials = $null
    }
    Write-Host '  deleted'
  }

  # The stack keeps the repository on purpose, so a stack mistake never loses rollback images.
  if ((Invoke-Aws @('ecr', 'describe-repositories', '--repository-names', $Repository) -Quiet -AllowFailure).Ok) {
    Say "Deleting the $Repository repository and its images"
    Invoke-Aws @('ecr', 'delete-repository', '--repository-name', $Repository, '--force') -Quiet | Out-Null
  }

  if ($Secrets) {
    Say 'Deleting secrets'
    $names = @(Get-StoredSecrets | ForEach-Object { "$SecretsPath/$_" })
    if ($names.Count) { Invoke-Aws (@('ssm', 'delete-parameters', '--names') + $names) -Quiet | Out-Null }
  }

  # Without the variable, pushes to main only run the tests instead of failing a deploy.
  if ((Get-Command gh -ErrorAction SilentlyContinue) -and
      (Invoke-Native 'gh' @('variable', 'get', 'AWS_DEPLOY_ROLE_ARN', '-R', $GithubRepo) -Quiet).Ok) {
    & gh variable delete AWS_DEPLOY_ROLE_ARN -R $GithubRepo
  }

  Say 'Done. Left in place: the CDKToolkit bootstrap (cents a month) and the IAM user.'
  if (-not $Secrets) { Write-Host 'Secrets are free and were kept; add -Secrets to delete them.' }
}

function Invoke-Status {
  Test-Preflight
  $status = Get-StackStatus
  Say 'Stack'; Write-Host "  ${Stack}: $status"
  Say 'Secrets present'; Get-StoredSecrets | ForEach-Object { Write-Host "  $_" }
  if ($status -ne 'NONE') {
    Write-Host "  instance: $(Get-Output 'InstanceId')  ip: $(Get-Output 'ElasticIpAddress')"
    Test-Dns | Out-Null
    Say 'Health'
    try { Write-Host "  $((Invoke-WebRequest "https://$ApiHost/health" -UseBasicParsing -TimeoutSec 10).Content)" }
    catch { Warn '  unreachable' }
  }
}

try {
  switch ($Command) {
    'up' { Invoke-Up }
    'down' { Invoke-Down }
    'status' { Invoke-Status }
    default { Get-Help $PSCommandPath -Detailed | Out-String | Write-Host; exit 2 }
  }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
