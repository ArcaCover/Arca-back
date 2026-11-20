<#
.SYNOPSIS
  Old name of scripts/arca-webapp-secrets.ps1, which now stores Resend's key next to Stripe's secrets. Forwards every
  parameter there; see that script for what it does.
#>
param(
  [ValidateSet('test', 'live')][string]$Mode = 'test',
  [ValidateSet('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY')][string[]]$Only,
  [switch]$Status
)

& (Join-Path $PSScriptRoot 'arca-webapp-secrets.ps1') @PSBoundParameters
