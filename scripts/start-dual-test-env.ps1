param(
  [string]$ServerUrl = 'http://127.0.0.1:3000',
  [int]$Port = 3000,
  [string]$HostProfile = 'dev-host',
  [string]$ViewerProfile = 'dev-viewer',
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

Start-DevWindow -Title 'VDS Dev Host' -CommandBody @"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
`$env:SERVER_URL = '$normalizedServerUrl'
`$env:VDS_PROFILE = '$HostProfile'
`$env:VDS_ENABLE_NATIVE_PEER_TRANSPORT = '$([int]$nativePeerTransportEnabled)'
npm start
"@

Start-DevWindow -Title 'VDS Dev Viewer' -CommandBody @"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
`$env:SERVER_URL = '$normalizedServerUrl'
`$env:VDS_PROFILE = '$ViewerProfile'
`$env:VDS_ENABLE_NATIVE_PEER_TRANSPORT = '$([int]$nativePeerTransportEnabled)'
npm start
"@

Write-Host "Dual dev environment launched."
Write-Host "Server: $normalizedServerUrl"
Write-Host "Host profile: $HostProfile"
Write-Host "Viewer profile: $ViewerProfile"
Write-Host "Native peer transport: $nativePeerTransportEnabled"
