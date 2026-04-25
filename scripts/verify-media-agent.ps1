param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

Push-Location $repoRoot
try {
  npm run build:media-agent
  if ($LASTEXITCODE -ne 0) {
    throw "media-agent build failed with exit code $LASTEXITCODE"
  }

  & (Join-Path $PSScriptRoot 'test-media-agent.ps1') -Configuration $Configuration
  & (Join-Path $PSScriptRoot 'smoke-media-agent.ps1')

  Write-Host 'media-agent verification passed'
} finally {
  Pop-Location
}
