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
  Write-Host '4. Packaged native preview'
  Write-Host '   Command: launch the installed app package, create a native host room, then start sharing.'
  Write-Host '   Pass criteria: host preview appears, is not black, and recovers after move/minimize/restore.'
  Write-Host ''
  Write-Host '5. Native viewer window move'
  Write-Host '   Command: npm run dev:dual:native'
  Write-Host '   Pass criteria: drag the viewer window while video is playing; video does not freeze long-term and surface recover does not loop.'
  Write-Host ''
  Write-Host '6. Host stop and immediate restart'
  Write-Host '   Command: npm run dev:dual:native'
  Write-Host '   Pass criteria: stop sharing without exiting, immediately share again, and confirm a new room, manifest, and sessionToken are used.'
  Write-Host ''
  Write-Host '7. Web v1/v2 relay and failover'
  Write-Host '   Command: use web viewers with a host room, then add v1 and v2 in sequence.'
  Write-Host '   Pass criteria: relay is preferred, failed upstream reselects, each upstream has at most two downstreams, and audio playback/forwarding is correct.'
  Write-Host ''
  Write-Host '8. Forced close disconnect behavior'
  Write-Host '   Command: close host or v1 process/window while downstream viewers are playing.'
  Write-Host '   Pass criteria: downstream viewers show disconnect or reselect after grace time and do not stay frozen with stale chain position.'
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
