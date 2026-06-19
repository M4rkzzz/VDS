param(
  [string]$AgentPath = '',
  [int]$TimeoutSeconds = 15,
  [switch]$RequireTransportReady
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
if (-not $AgentPath) {
  $AgentPath = Join-Path $repoRoot 'runtime\media-agent\vds-media-agent.exe'
}

if (-not (Test-Path $AgentPath)) {
  throw "media-agent binary not found: $AgentPath. Run npm run build:media-agent first."
}

function Get-FreeUdpPort {
  $client = [System.Net.Sockets.UdpClient]::new(0)
  try {
    return ([System.Net.IPEndPoint]$client.Client.LocalEndPoint).Port
  } finally {
    $client.Close()
  }
}

$obsIngestPort = Get-FreeUdpPort

$requests = @(
  '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  '{"jsonrpc":"2.0","id":2,"method":"getCapabilities"}',
  '{"jsonrpc":"2.0","id":3,"method":"getStatus"}',
  '{"jsonrpc":"2.0","id":4,"method":"getStats"}',
  '{"jsonrpc":"2.0","id":5,"method":"unknownMethod"}',
  '{"jsonrpc":"2.0","id":6}',
  ('{{"jsonrpc":"2.0","id":7,"method":"prepareObsIngest","port":{0},"refresh":true}}' -f $obsIngestPort)
)

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $AgentPath
$startInfo.WorkingDirectory = Split-Path -Parent $AgentPath
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$null = $process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()

try {
  foreach ($request in $requests) {
    $process.StandardInput.WriteLine($request)
  }
  $process.StandardInput.Close()

  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill($true) } catch { try { $process.Kill() } catch {} }
    throw "media-agent smoke test timed out after $TimeoutSeconds seconds."
  }
  $process.WaitForExit()
  [void]$stdoutTask.Wait(5000)
  [void]$stderrTask.Wait(5000)
} finally {
  if (-not $process.HasExited) {
    try { $process.Kill($true) } catch { try { $process.Kill() } catch {} }
  }
}

$stdoutText = $stdoutTask.Result
$stderrText = $stderrTask.Result

if ($process.ExitCode -ne 0) {
  throw "media-agent smoke test process failed with exit code $($process.ExitCode). $stderrText"
}

$stdoutLines = $stdoutText -split "`r?`n"

$messages = @()
foreach ($line in $stdoutLines) {
  if (-not $line) {
    continue
  }
  try {
    $messages += ($line | ConvertFrom-Json)
  } catch {
    throw "media-agent emitted invalid JSON line: $line"
  }
}

$ready = $messages | Where-Object { $_.event -eq 'agent-ready' } | Select-Object -First 1
if (-not $ready) {
  throw 'media-agent smoke test did not receive agent-ready event.'
}
if ($RequireTransportReady) {
  $capabilitiesResponse = $messages | Where-Object { $_.id -eq 2 } | Select-Object -First 1
  $transportReady = $false
  if ($capabilitiesResponse -and $capabilitiesResponse.result) {
    $transportReady = [bool]($capabilitiesResponse.result.peerTransport -and $capabilitiesResponse.result.peerTransport.transportReady)
    if (-not $transportReady) {
      $transportReady = [bool]($capabilitiesResponse.result.transportReady)
    }
  }
  if (-not $transportReady) {
    throw "media-agent smoke test expected libdatachannel transportReady capability. Capabilities: $($capabilitiesResponse.result | ConvertTo-Json -Compress -Depth 8)"
  }
}

foreach ($id in 1..4) {
  $response = $messages | Where-Object { $_.id -eq $id } | Select-Object -First 1
  if (-not $response) {
    throw "media-agent smoke test missing response id=$id."
  }
  if ($response.PSObject.Properties.Name -contains 'error') {
    throw "media-agent smoke test response id=$id returned error: $($response.error | ConvertTo-Json -Compress)"
  }
  if (-not ($response.PSObject.Properties.Name -contains 'result')) {
    throw "media-agent smoke test response id=$id did not include result."
  }
}

$obsIngestResponse = $messages | Where-Object { $_.id -eq 7 } | Select-Object -First 1
if (-not $obsIngestResponse) {
  throw 'media-agent smoke test missing prepareObsIngest response id=7.'
}
if ($obsIngestResponse.PSObject.Properties.Name -contains 'error') {
  throw "media-agent smoke test prepareObsIngest returned error: $($obsIngestResponse.error | ConvertTo-Json -Compress)"
}
if (-not $obsIngestResponse.result -or -not $obsIngestResponse.result.obsIngest -or -not $obsIngestResponse.result.obsIngest.prepared) {
  throw 'media-agent smoke test prepareObsIngest did not report prepared obsIngest state.'
}
if ([int]$obsIngestResponse.result.obsIngest.port -ne $obsIngestPort) {
  throw "media-agent smoke test prepareObsIngest expected port $obsIngestPort, got $($obsIngestResponse.result.obsIngest.port)."
}
if ([string]$obsIngestResponse.result.obsIngest.url -notlike "srt://127.0.0.1:$obsIngestPort*") {
  throw "media-agent smoke test prepareObsIngest returned unexpected url: $($obsIngestResponse.result.obsIngest.url)"
}

function Assert-ErrorResponse {
  param(
    [int]$Id,
    [string]$Code
  )

  $response = $messages | Where-Object { $_.id -eq $Id } | Select-Object -First 1
  if (-not $response) {
    throw "media-agent smoke test missing error response id=$Id."
  }
  if (-not ($response.PSObject.Properties.Name -contains 'error')) {
    throw "media-agent smoke test response id=$Id did not include error."
  }
  if ($response.error.code -ne $Code) {
    throw "media-agent smoke test response id=$Id expected error code $Code, got $($response.error.code)."
  }
}

Assert-ErrorResponse -Id 5 -Code 'NOT_IMPLEMENTED'
Assert-ErrorResponse -Id 6 -Code 'BAD_REQUEST'

Write-Host 'media-agent smoke test passed'
