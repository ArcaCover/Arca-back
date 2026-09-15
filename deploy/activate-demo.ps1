param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$RepositoryUri,
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [Parameter(Mandatory = $true)][string]$ImageTag
)

$ErrorActionPreference = 'Stop'
if ($ImageTag -notmatch '^[0-9a-f]{7,40}$') { throw 'ImageTag must be a Git commit SHA' }
$image = "${RepositoryUri}:$ImageTag"
$parameterFile = New-TemporaryFile
try {
  $json = @{ commands = @("sudo /opt/arca/deploy/deploy-image.sh '$image' '$Region'") } | ConvertTo-Json -Compress
  # Written through .NET because Set-Content's utf8NoBOM does not exist in Windows PowerShell 5.1.
  [System.IO.File]::WriteAllText($parameterFile.FullName, $json, (New-Object System.Text.UTF8Encoding($false)))
  $commandId = aws ssm send-command --region $Region --instance-ids $InstanceId `
    --document-name AWS-RunShellScript --comment "Activate ARCA $ImageTag" `
    --parameters "file://$($parameterFile.FullName)" --query 'Command.CommandId' --output text
  if (-not $commandId) { throw 'SSM did not return a command id' }
  aws ssm wait command-executed --region $Region --command-id $commandId --instance-id $InstanceId
  aws ssm get-command-invocation --region $Region --command-id $commandId --instance-id $InstanceId `
    --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' --output json
} finally {
  Remove-Item -LiteralPath $parameterFile -Force -ErrorAction SilentlyContinue
}
