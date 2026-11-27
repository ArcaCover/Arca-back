<#
.SYNOPSIS
  Writes pilot's secrets to SSM under /arca/pilot (DN-14 §5). Run it once, before the first pilot deploy.

.DESCRIPTION
  Generates the secrets nobody needs to know: the local Postgres passwords, PostgREST's JWT secret, the service_role JWT the
  API uses as SUPABASE_SECRET_KEY, the session secret and the pilot access token. Asks for the Apify and OpenAI keys without
  echo, or, with -CopyKeysFromProd, copies production's inside AWS without showing them. No value is ever printed: the pilot
  access token goes to the clipboard, for Vercel (NEXT_PUBLIC_PILOT_ACCESS_TOKEN on the pilot branch).

  Existing parameters are kept unless -Force: the database passwords only take effect when pilot's database is created, so
  changing them later locks the API out of a database that already exists.

.EXAMPLE
  .\scripts\arca-pilot-secrets.ps1 -CopyKeysFromProd
#>
param(
  [string]$AwsProfile = 'arca-deploy',
  [string]$Region = 'us-east-1',
  [switch]$CopyKeysFromProd,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
$path = '/arca/pilot'

function New-Secret([int]$bytes = 48) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  # URL-safe base64 without padding: safe in env files, URLs and headers.
  return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function ConvertTo-Base64Url([byte[]]$value) { [Convert]::ToBase64String($value).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function New-ServiceRoleJwt([string]$secret) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $header = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
  $payload = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes("{""role"":""service_role"",""iss"":""arca-pilot"",""iat"":$now,""exp"":$($now + 315360000)}"))
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 (,[Text.Encoding]::UTF8.GetBytes($secret))
  $signature = ConvertTo-Base64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$header.$payload")))
  return "$header.$payload.$signature"
}
function Test-Parameter([string]$name) {
  aws ssm get-parameter --profile $AwsProfile --region $Region --name "$path/$name" --query Parameter.Name --output text 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}
function Set-Parameter([string]$name, [string]$value, [switch]$Always) {
  if (-not $Always -and -not $Force -and (Test-Parameter $name)) { Write-Host "  kept    $path/$name (already set; -Force replaces it)"; return }
  # The value goes through a temporary file, never the command line, so it shows in no process list or history.
  $file = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($file.FullName, $value)
    aws ssm put-parameter --profile $AwsProfile --region $Region --name "$path/$name" --type SecureString --overwrite `
      --value "file://$($file.FullName)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not write $path/$name" }
    Write-Host "  written $path/$name"
  } finally { Remove-Item $file.FullName -Force }
}
function Read-Key([string]$name) {
  $secure = Read-Host "$name (not shown)" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if (-not $plain.Trim()) { throw "$name is empty" }
  return $plain.Trim()
}
function Get-ProdKey([string]$name) {
  $value = aws ssm get-parameter --profile $AwsProfile --region $Region --name "/arca/prod/$name" --with-decryption --query Parameter.Value --output text
  if ($LASTEXITCODE -ne 0 -or -not $value) { throw "Could not read /arca/prod/$name" }
  return $value
}

Write-Host "Pilot secrets under $path (profile $AwsProfile, $Region)"
$jwtSecret = if ((Test-Parameter 'PGRST_JWT_SECRET') -and -not $Force) { $null } else { New-Secret 48 }
Set-Parameter 'POSTGRES_PASSWORD' (New-Secret 32)
Set-Parameter 'AUTHENTICATOR_PASSWORD' (New-Secret 32)
if ($jwtSecret) {
  Set-Parameter 'PGRST_JWT_SECRET' $jwtSecret
  # Only valid with the JWT secret written beside it, so both are written together.
  Set-Parameter 'SUPABASE_SECRET_KEY' (New-ServiceRoleJwt $jwtSecret) -Always
} else { Write-Host "  kept    $path/PGRST_JWT_SECRET and $path/SUPABASE_SECRET_KEY" }
Set-Parameter 'SESSION_TOKEN_SECRET' (New-Secret 48)
if (-not (Test-Parameter 'PILOT_ACCESS_TOKEN') -or $Force) {
  $token = New-Secret 36
  Set-Parameter 'PILOT_ACCESS_TOKEN' $token
  Set-Clipboard -Value $token
  Write-Host "  The pilot access token is on the clipboard: paste it in Vercel as NEXT_PUBLIC_PILOT_ACCESS_TOKEN for the pilot branch."
}
foreach ($name in 'APIFY_API_TOKEN', 'OPENAI_API_KEY') {
  if ((Test-Parameter $name) -and -not $Force) { Write-Host "  kept    $path/$name"; continue }
  $value = if ($CopyKeysFromProd) { Get-ProdKey $name } else { Read-Key $name }
  Set-Parameter $name $value
}
Write-Host 'Done. Nothing was printed. Next: push to the pilot branch (or run the Deploy pilot workflow).'
