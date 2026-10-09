param(
  [Parameter(Mandatory = $true)]
  [string]$AgentPath
)

$ErrorActionPreference = 'Stop'

function Get-FreeUdpPort {
  $client = [System.Net.Sockets.UdpClient]::new(0)
  try {
    return ([System.Net.IPEndPoint]$client.Client.LocalEndPoint).Port
  } finally {
    $client.Close()
  }
}

$portA = Get-FreeUdpPort
$portB = Get-FreeUdpPort
while ($portB -eq $portA) { $portB = Get-FreeUdpPort }

$requests = @(
  @{ id = 1; method = 'startHostSession'; mediaSessionId = 'owner-a'; backend = 'obs-ingest'; port = $portA },
  @{ id = 2; method = 'startHostSession'; mediaSessionId = 'owner-b'; backend = 'obs-ingest'; port = $portB },
  @{ id = 3; method = 'stopHostSession'; mediaSessionId = 'owner-b' },
  @{ id = 4; method = 'prepareObsIngest'; mediaSessionId = 'owner-b'; port = $portB },
  @{ id = 5; method = 'startAudioSession'; mediaSessionId = 'owner-b'; pid = 0 },
  @{ id = 6; method = 'stopAudioSession'; mediaSessionId = 'owner-b' },
  @{ id = 7; method = 'getStatus' },
  @{ id = 8; method = 'startHostSession'; mediaSessionId = 'owner-a'; backend = 'obs-ingest'; port = $portA },
  @{ id = 9; method = 'stopHostSession'; mediaSessionId = 'owner-a' },
  @{ id = 10; method = 'startHostSession'; mediaSessionId = 'owner-b'; backend = 'obs-ingest'; port = $portB },
  @{ id = 11; method = 'stopHostSession'; mediaSessionId = 'owner-b' },
  @{ id = 12; method = 'startHostSession'; mediaSessionId = 'owner-b'; backend = 'obs-ingest'; port = $portB },
  @{ id = 13; method = 'stopHostSession'; mediaSessionId = 'owner-b' },
  @{ id = 14; method = 'startHostSession'; sessionId = 'owner-a'; backend = 'obs-ingest'; port = $portA },
  @{ id = 15; method = 'getStatus' },
  @{ id = 16; method = 'createPeer'; peerId = 'stun-selected'; role = 'viewer-upstream'; initiator = $false; stunServer = 'stun:stun.linphone.org:3478' },
  @{ id = 17; method = 'getStats' },
  @{ id = 18; method = 'createPeer'; peerId = 'reject-turn'; stunServer = 'turn:relay.example.com:3478' },
  @{ id = 19; method = 'createPeer'; peerId = 'reject-turns'; stunServer = 'turns:relay.example.com:5349' },
  @{ id = 20; method = 'createPeer'; peerId = 'reject-relay'; stunServer = 'relay:relay.example.com:3478' },
  @{ id = 21; method = 'createPeer'; peerId = 'reject-empty-stun'; stunServer = '' },
  @{ id = 22; method = 'getStats' },
  @{ id = 23; method = 'closePeer'; peerId = 'stun-selected' },
  @{ id = 24; method = 'createPeer'; peerId = 'stun-default'; initiator = $false },
  @{ id = 25; method = 'getStats' },
  @{ id = 26; method = 'closePeer'; peerId = 'stun-default' },
  @{ id = 27; method = 'getStats' },
  @{ id = 28; method = 'createPeer'; nested = $true; peerId = 'stun-pool'; initiator = $false; stunServer = 'stun:127.0.0.1:3478'; stunServers = @('stun:127.0.0.1:3478', 'stun:[::1]:3478') },
  @{ id = 29; method = 'getStats' },
  @{ id = 30; method = 'closePeer'; peerId = 'stun-pool' },
  @{ id = 31; method = 'createPeer'; nested = $true; peerId = 'reject-turn-pool'; stunServers = @('turn:relay.example.com:3478') },
  @{ id = 32; method = 'createPeer'; nested = $true; peerId = 'reject-turns-pool'; stunServers = @('turns:relay.example.com:5349') },
  @{ id = 33; method = 'createPeer'; nested = $true; peerId = 'reject-number-pool'; stunServers = @(3478) },
  @{ id = 34; method = 'createPeer'; nested = $true; peerId = 'reject-null-pool'; stunServers = $null },
  @{ id = 35; method = 'createPeer'; nested = $true; peerId = 'reject-string-pool'; stunServers = 'stun:127.0.0.1:3478' },
  @{ id = 36; method = 'createPeer'; nested = $true; peerId = 'reject-oversized-pool'; stunServers = @('stun:127.0.0.1:3478', 'stun:127.0.0.1:3478', 'stun:127.0.0.1:3478', 'stun:127.0.0.1:3478', 'stun:127.0.0.1:3478') },
  @{ id = 37; method = 'createPeer'; nested = $true; peerId = 'reject-empty-pool-entry'; stunServers = @('') },
  @{ id = 38; method = 'createPeer'; nested = $true; peerId = 'reject-port-pool'; stunServers = @('stun:[::1]:65536') },
  @{ id = 39; rawJson = '{"jsonrpc":"2.0","id":39,"method":"createPeer","params":{"peerId":"reject-duplicate-pool","stunServers":[],"stunServers":["stun:127.0.0.1:3478"]}}' },
  @{ id = 40; rawJson = '{"jsonrpc":"2.0","id":40,"method":"createPeer","params":{"peerId":"reject-malformed-pool","stunServers":["stun:127.0.0.1:3478",]}}' },
  @{ id = 41; rawJson = '{"jsonrpc":"2.0","id":41,"method":"createPeer","params":{"peerId":"reject-unclosed-pool","stunServers":["stun:[::1]:3478"}}' },
  @{ id = 42; method = 'getStats' },
  @{ id = 43; method = 'createPeer'; nested = $true; peerId = 'stun-empty-pool'; initiator = $false; stunServer = 'stun:127.0.0.1:3478'; stunServers = @() },
  @{ id = 44; method = 'getStats' },
  @{ id = 45; method = 'closePeer'; peerId = 'stun-empty-pool' },
  @{ id = 46; method = 'getStats' },
  @{ id = 47; rawJson = '{"jsonrpc":"2.0","id":47,"method":"createPeer","params":{"peerId":"reject-duplicate-params"},"params":{"stunServers":[]}}' },
  @{ id = 48; rawJson = '{"jsonrpc":"2.0","id":48,"method":"createPeer","peerId":"reject-null-params","params":null}' },
  @{ id = 49; rawJson = '{"jsonrpc":"2.0","id":49,"method":"createPeer","stunServer":"stun:127.0.0.1:3478","params":{"peerId":"reject-mixed-single","stunServer":"stun:127.0.0.1:3478"}}' },
  @{ id = 50; rawJson = '{"jsonrpc":"2.0","id":50,"method":"createPeer","stunServers":[],"params":{"peerId":"reject-mixed-pool","stunServers":[]}}' },
  @{ id = 51; method = 'createPeer'; nested = $true; peerId = 'reject-invalid-ipv6-pool'; stunServers = @('stun:[:::]:3478') },
  @{ id = 52; method = 'createPeer'; nested = $true; peerId = 'reject-nested-single-turn'; stunServer = 'turn:relay.example.com:3478' },
  @{ id = 53; method = 'createPeer'; nested = $true; peerId = 'reject-nested-single-type'; stunServer = 3478 },
  @{ id = 54; method = 'getStats' },
  @{ id = 55; method = 'startAudioSession'; mediaSessionId = 'owner-a'; pid = $PID; processName = 'VDS owned lifecycle fixture' },
  @{ id = 56; method = 'startHostSession'; mediaSessionId = 'owner-b'; backend = 'obs-ingest'; port = $portB },
  @{ id = 57; method = 'stopHostSession'; mediaSessionId = 'owner-a' },
  @{ id = 58; method = 'startHostSession'; mediaSessionId = 'owner-b'; backend = 'obs-ingest'; port = $portB },
  @{ id = 59; method = 'stopHostSession'; mediaSessionId = 'owner-b' }
)

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $AgentPath
$startInfo.WorkingDirectory = Split-Path -Parent $AgentPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$null = $process.Start()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()

try {
  foreach ($request in $requests) {
    if ($request.rawJson) {
      $process.StandardInput.WriteLine($request.rawJson)
    } elseif ($request.nested) {
      $requestParams = @{}
      foreach ($entry in $request.GetEnumerator()) {
        if ($entry.Key -notin @('id', 'method', 'nested')) { $requestParams[$entry.Key] = $entry.Value }
      }
      $wireRequest = @{ jsonrpc = '2.0'; id = $request.id; method = $request.method; params = $requestParams }
      $process.StandardInput.WriteLine(($wireRequest | ConvertTo-Json -Compress -Depth 8))
    } else {
      $request.jsonrpc = '2.0'
      $process.StandardInput.WriteLine(($request | ConvertTo-Json -Compress))
    }
  }
  # EOF must join the last active OBS worker as well as previously stopped workers.
  $process.StandardInput.Close()
  # The fixture includes cold initialization, then the existing RPC lifecycle.
  if (-not $process.WaitForExit(105000)) {
    throw 'Native RPC lifecycle test timed out.'
  }
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    throw "Native RPC lifecycle process exited with $($process.ExitCode). $($stderrTask.Result)"
  }

  $responses = @{}
  foreach ($line in ($stdoutTask.Result -split "`r?`n")) {
    if (-not $line) { continue }
    $message = $line | ConvertFrom-Json
    if ($message.PSObject.Properties.Name -contains 'id') {
      $responses[[int]$message.id] = $message
    }
  }
  foreach ($request in $requests) {
    if (-not $responses.ContainsKey($request.id)) {
      throw "Missing lifecycle response id=$($request.id)."
    }
  }
  foreach ($id in 2..6) {
    if ($responses[$id].error.code -ne 'MEDIA_SESSION_ACTIVE') {
      throw "Expected owner conflict for id=$id."
    }
  }
  $firstStatus = $responses[7].result
  foreach ($field in @('hostSessionId', 'audioSessionId', 'obsIngestSessionId')) {
    if ($firstStatus.$field -ne 'owner-a') { throw "Rejected switch changed $field." }
  }
  foreach ($field in @('hostSessionCount', 'audioSessionCount', 'obsIngestSessionCount')) {
    if ($firstStatus.$field -ne 2) { throw "Rejected switch created registry state in $field." }
  }
  if (-not $firstStatus.hostSessionRunning) { throw 'Rejected stop stopped the active owner.' }
  foreach ($id in @(1, 8, 10, 12, 14)) {
    if (-not $responses[$id].result.running) { throw "Start/restart failed for id=$id." }
  }
  foreach ($id in @(9, 11, 13)) {
    if ($responses[$id].error -or $responses[$id].result.running) {
      throw "Stop failed for id=$id."
    }
  }
  $finalStatus = $responses[15].result
  if ($finalStatus.hostSessionId -ne 'owner-a' -or $finalStatus.hostSessionCount -ne 3 -or
      -not $finalStatus.hostSessionRunning) {
    throw 'Stopped owners could not switch and restart successfully.'
  }
  if ($responses[16].error) { throw 'Selected STUN peer creation failed.' }
  $selectedPeer = @($responses[17].result.peers | Where-Object { $_.peerId -eq 'stun-selected' })
  if ($selectedPeer.Count -ne 1) { throw 'Selected STUN peer was not created.' }
  if ($responses[16].result.transportReady -and
      $selectedPeer[0].peerTransport.selectedStunServer -ne 'stun:stun.linphone.org:3478') {
    throw 'The native transport ignored the selected STUN server.'
  }
  foreach ($id in 18..21) {
    if ($responses[$id].error.code -ne 'BAD_REQUEST') {
      throw "Invalid/relay STUN configuration was accepted for id=$id."
    }
  }
  if (@($responses[22].result.peers).Count -ne 1) { throw 'Rejected STUN requests created peer state.' }
  $defaultPeer = @($responses[25].result.peers)
  if ($responses[24].error -or $defaultPeer.Count -ne 1 -or
      $defaultPeer[0].peerTransport.selectedStunServer) { throw 'Legacy STUN defaults were not preserved.' }
  if (@($responses[27].result.peers).Count -ne 0) { throw 'STUN peers were not closed.' }
  $poolPeer = @($responses[29].result.peers)
  if ($responses[28].error -or $poolPeer.Count -ne 1) { throw 'Multi-STUN peer creation failed.' }
  if ($responses[28].result.transportReady -and
      (($poolPeer[0].peerTransport.stunServers -join ',') -ne 'stun:127.0.0.1:3478,stun:[::1]:3478' -or
       $poolPeer[0].peerTransport.selectedStunServer -ne 'stun:127.0.0.1:3478')) {
    $actualPool = $poolPeer[0].peerTransport.stunServers | ConvertTo-Json -Compress
    $actualPrimary = $poolPeer[0].peerTransport.selectedStunServer
    $actualPhase = $poolPeer[0].sessionPhase
    $actualError = $poolPeer[0].peerTransport.lastError
    throw "Native multi-STUN configuration lost the primary, pool order or IPv6 brackets. primary=$actualPrimary pool=$actualPool phase=$actualPhase error=$actualError"
  }
  foreach ($id in 31..41) {
    if ($responses[$id].error.code -ne 'BAD_REQUEST') { throw "Invalid STUN pool was accepted for id=$id." }
  }
  if (@($responses[42].result.peers).Count -ne 0) { throw 'Rejected STUN pool requests created peer state.' }
  $emptyPoolPeer = @($responses[44].result.peers)
  if ($responses[43].error -or $emptyPoolPeer.Count -ne 1 -or
      ($responses[43].result.transportReady -and $emptyPoolPeer[0].peerTransport.selectedStunServer -ne 'stun:127.0.0.1:3478')) {
    throw 'An empty STUN pool broke the selected single-server option.'
  }
  if (@($responses[46].result.peers).Count -ne 0) { throw 'STUN pool peers were not closed.' }
  foreach ($id in 47..53) {
    if ($responses[$id].error.code -ne 'BAD_REQUEST') { throw "Invalid or ambiguous RPC params were accepted for id=$id." }
  }
  if (@($responses[54].result.peers).Count -ne 0) { throw 'Rejected RPC params requests created peer state.' }
  if ($responses[55].error) { throw 'Owned process audio start failed.' }
  if ($responses[56].error.code -ne 'MEDIA_SESSION_ACTIVE') { throw 'Active share owner isolation was lost.' }
  if ($responses[57].error -or $responses[57].result.running) { throw 'Combined audio/video stop failed.' }
  if ($responses[58].error -or -not $responses[58].result.running) { throw 'Host stop left audio blocking the next owner.' }
  if ($responses[59].error -or $responses[59].result.running) { throw 'Restarted owner stop failed.' }
  Write-Host "Owned process audio was active before host stop: $($responses[55].result.captureActive)"
  Write-Host 'media-agent RPC lifecycle tests passed'
} finally {
  if (-not $process.HasExited) { $process.Kill() }
  $process.Dispose()
}
