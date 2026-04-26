param(
  [string]$ServerUrl = 'http://127.0.0.1:3000',
  [int]$Port = 3000,
  [Alias('HostProfile')]
  [string]$ClientAProfile = 'dev-client-a',
  [Alias('ViewerProfile')]
  [string]$ClientBProfile = 'dev-client-b',
  [ValidateSet('quiet', 'diagnose', 'traceVideo', 'verbose', 'profile')]
  [string]$DebugPreset = 'diagnose',
  [switch]$EnableNativePeerTransport,
  [switch]$SkipServer,
  [switch]$SkipBuild,
  [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$normalizedServerUrl = $ServerUrl.TrimEnd('/')
$nativePeerTransportEnabled = $EnableNativePeerTransport.IsPresent -or $env:VDS_ENABLE_NATIVE_PEER_TRANSPORT -eq '1'

function Start-DevWindow {
  param(
    [string]$Title,
    [string]$CommandBody
  )

  $fullCommand = @"
`$Host.UI.RawUI.WindowTitle = '$Title'
Set-Location '$repoRoot'
$CommandBody
"@

  Start-Process powershell -WorkingDirectory $repoRoot -ArgumentList @(
    '-NoExit',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $fullCommand
  ) | Out-Null
}

function Test-HttpReady {
  param(
    [string]$Url
  )

  try {
    $null = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 2
    return $true
  } catch {
    return $false
  }
}

function Wait-ForServer {
  param(
    [string]$BaseUrl
  )

  $healthUrl = "$BaseUrl/api/version"
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-HttpReady -Url $healthUrl) {
      return $true
    }

    Start-Sleep -Milliseconds 500
  }

  return $false
}

function Start-NativeClientWindow {
  param(
    [string]$Title,
    [string]$Profile
  )

  Start-DevWindow -Title $Title -CommandBody @"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
`$env:SERVER_URL = '$normalizedServerUrl'
`$env:VDS_PROFILE = '$Profile'
`$env:VDS_ENABLE_NATIVE_PEER_TRANSPORT = '$([int]$nativePeerTransportEnabled)'
`$env:VDS_DEBUG_PRESET = '$DebugPreset'
npm start
"@
}

if (-not $SkipBuild) {
  Push-Location $repoRoot
  try {
    npm run build:vds-web
  } finally {
    Pop-Location
  }
}

if (-not $SkipServer) {
  $serverReady = Test-HttpReady -Url "$normalizedServerUrl/api/version"
  if (-not $serverReady) {
    Start-DevWindow -Title 'VDS Local Server' -CommandBody @"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
`$env:PORT = '$Port'
npm run server
"@

    if (-not (Wait-ForServer -BaseUrl $normalizedServerUrl)) {
      throw "Local server did not become ready at $normalizedServerUrl"
    }
  }
}

Start-NativeClientWindow -Title 'VDS NWN Host Native' -Profile $ClientAProfile

if (-not $SkipBrowser) {
  Start-Sleep -Milliseconds 750
  Start-Process $normalizedServerUrl | Out-Null
}

Start-Sleep -Milliseconds 750
Start-NativeClientWindow -Title 'VDS NWN Viewer Native' -Profile $ClientBProfile

Write-Host "Triple NWN dev environment launched."
Write-Host "Server: $normalizedServerUrl"
Write-Host "Native host profile: $ClientAProfile"
Write-Host "Web viewer: $(-not $SkipBrowser)"
Write-Host "Native viewer profile: $ClientBProfile"
Write-Host "Debug preset: $DebugPreset"
Write-Host "Native peer transport: $nativePeerTransportEnabled"
Write-Host "Suggested test order: create a room in the native host, join from the browser, then join from the second native client."
