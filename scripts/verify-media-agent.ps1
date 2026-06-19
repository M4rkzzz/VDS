param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [string]$FfmpegSourceRoot = $env:VDS_FFMPEG_SOURCE,
  [switch]$AllowLocalFfmpegFallback
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

Push-Location $repoRoot
try {
  $buildArgs = @{
    Configuration = $Configuration
  }
  if ($FfmpegSourceRoot) {
    $buildArgs.FfmpegSourceRoot = $FfmpegSourceRoot
  }
  if ($AllowLocalFfmpegFallback) {
    $buildArgs.AllowLocalFfmpegFallback = $true
  }
  & (Join-Path $PSScriptRoot 'build-media-agent.ps1') @buildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "media-agent build failed with exit code $LASTEXITCODE"
  }

  & (Join-Path $PSScriptRoot 'test-media-agent.ps1') -Configuration $Configuration
  $smokeArgs = @{}
  if ($Configuration -eq 'Release') {
    $smokeArgs.RequireTransportReady = $true
  }
  & (Join-Path $PSScriptRoot 'smoke-media-agent.ps1') @smokeArgs

  Write-Host 'media-agent verification passed'
} finally {
  Pop-Location
}
