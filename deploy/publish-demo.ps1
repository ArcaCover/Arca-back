param(
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$RepositoryUri,
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [string]$ImageTag = (git rev-parse HEAD)
)

$ErrorActionPreference = 'Stop'
if ($ImageTag -notmatch '^[0-9a-f]{7,40}$') { throw 'ImageTag must be a Git commit SHA' }
if (git status --porcelain) { throw 'Deployment requires a clean, committed working tree' }
$head = git rev-parse HEAD
if ($ImageTag -ne $head) { throw 'Build tag must equal the checked-out Git commit' }

$image = "${RepositoryUri}:$ImageTag"
$registry = $RepositoryUri.Split('/')[0]
$buildDate = [DateTime]::UtcNow.ToString('o')

npm ci
npm run build
npm test -- --reporter=dot
docker build --platform linux/amd64 --build-arg "VCS_REF=$ImageTag" --build-arg "BUILD_DATE=$buildDate" --tag $image .
aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $registry
docker push $image
& "$PSScriptRoot/activate-demo.ps1" -Region $Region -RepositoryUri $RepositoryUri `
  -InstanceId $InstanceId -ImageTag $ImageTag
