param(
  [switch]$LaunchDualNative,
  [switch]$LaunchTripleNative,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')

Push-Location $repoRoot
try {
  if (-not $SkipVerify) {
    npm run verify:media-agent
    if ($LASTEXITCODE -ne 0) {
      throw "media-agent verification failed with exit code $LASTEXITCODE"
    }
  }

  Write-Host ''
  Write-Host 'Manual media-agent e2e checklist'
  Write-Host '================================'
  Write-Host ''
  Write-Host '1. Dual native'
  Write-Host '   Command: npm run dev:dual:native'
  Write-Host '   Pass criteria: choose one client to create a room, have the other client join, native capture starts, joined client renders, audio plays, close/reconnect recovers.'
  Write-Host ''
  Write-Host '2. Triple native'
  Write-Host '   Command: npm run dev:triple:native'
  Write-Host '   Pass criteria: choose one client to create a room, have the other two clients join in sequence, cascade fanout works, both joined clients render, upstream disconnect/reconnect recovers.'
  Write-Host ''
  Write-Host '3. OBS ingest'
  Write-Host '   Command: npm run dev:dual:native'
  Write-Host '   On the room-creating client, choose OBS ingest in quality settings, copy the SRT URL, configure OBS output to that URL.'
  Write-Host '   Pass criteria: prepare/start/stop ingest works, joined client renders OBS video/audio, downstream attach/detach recovers.'
  Write-Host ''
  Write-Host 'Observe agent JSON-RPC responses, frontend status, native surface video, audio, and process cleanup.'
  Write-Host ''

  if ($LaunchDualNative) {
    npm run dev:dual:native
  }

  if ($LaunchTripleNative) {
    npm run dev:triple:native
  }
} finally {
  Pop-Location
}
