param(
  [string]$ServerUrl = 'http://127.0.0.1:3000',
  [int]$Port = 3000,
  [Alias('HostProfile')]
  [string]$ClientAProfile = 'dev-client-a',
  [Alias('ViewerProfile')]
  [string]$ClientBProfile = 'dev-client-b',
  [ValidateSet('quiet', 'diagnose', 'traceVideo', 'verbose', 'profile')]
  [string]$DebugPreset = 'quiet',
  [switch]$EnableNativePeerTransport,
  [switch]$SkipServer
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

Start-DevWindow -Title 'VDS Dev Client A' -CommandBody @"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
`$env:SERVER_URL = '$normalizedServerUrl'
`$env:VDS_PROFILE = '$ClientAProfile'
`$env:VDS_ENABLE_NATIVE_PEER_TRANSPORT = '$([int]$nativePeerTransportEnabled)'
`$env:VDS_DEBUG_PRESET = '$DebugPreset'
npm start
"@

Start-DevWindow -Title 'VDS Dev Client B' -CommandBody @"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
`$env:SERVER_URL = '$normalizedServerUrl'
`$env:VDS_PROFILE = '$ClientBProfile'
`$env:VDS_ENABLE_NATIVE_PEER_TRANSPORT = '$([int]$nativePeerTransportEnabled)'
`$env:VDS_DEBUG_PRESET = '$DebugPreset'
npm start
"@

Write-Host "Dual dev environment launched."
Write-Host "Server: $normalizedServerUrl"
Write-Host "Client A profile: $ClientAProfile"
Write-Host "Client B profile: $ClientBProfile"
Write-Host "Debug preset: $DebugPreset"
Write-Host "Native peer transport: $nativePeerTransportEnabled"
