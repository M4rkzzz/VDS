param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [string]$FfmpegSourceRoot = $env:VDS_FFMPEG_SOURCE
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$sourceDir = Join-Path $repoRoot 'media-agent'
$buildDir = Join-Path $sourceDir 'build'
$runtimeDir = Join-Path $repoRoot 'runtime\media-agent'
$runtimeFfmpegBinDir = Join-Path $runtimeDir 'ffmpeg\bin'
$vcpkgRoot = if ($env:VCPKG_ROOT) { $env:VCPKG_ROOT } elseif (Test-Path 'C:\vcpkg') { 'C:\vcpkg' } else { $null }
$vcpkgToolchain = if ($vcpkgRoot) { Join-Path $vcpkgRoot 'scripts\buildsystems\vcpkg.cmake' } else { $null }
$enableLibDataChannel = [bool]($vcpkgToolchain -and (Test-Path $vcpkgToolchain))
$libDataChannelOption = if ($enableLibDataChannel) { 'ON' } else { 'OFF' }

function Test-FfmpegSdkRoot {
  param(
    [string]$Path
  )

  if (-not $Path) {
    return $false
  }

  return (Test-Path (Join-Path $Path 'include\libavcodec\avcodec.h')) -and
    (Test-Path (Join-Path $Path 'lib\avcodec.lib')) -and
    (Test-Path (Join-Path $Path 'lib\avutil.lib')) -and
    (Test-Path (Join-Path $Path 'lib\swscale.lib'))
}

function Resolve-FfmpegSdkRoot {
  param(
    [string[]]$SearchRoots
  )

  foreach ($searchRoot in ($SearchRoots | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-FfmpegSdkRoot -Path $searchRoot) {
      return $searchRoot
    }
  }

  foreach ($searchRoot in ($SearchRoots | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path $searchRoot)) {
      continue
    }

    $headers = Get-ChildItem -Path $searchRoot -Recurse -File -Filter 'avcodec.h' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*\include\libavcodec\avcodec.h' }
    foreach ($header in $headers) {
      $candidateRoot = Split-Path (Split-Path (Split-Path $header.FullName -Parent) -Parent) -Parent
      if (Test-FfmpegSdkRoot -Path $candidateRoot) {
        return $candidateRoot
      }
    }
  }

  return $null
}

function Get-FfmpegMetadata {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath
  )

  $versionLine = ''
  $devicesOutput = ''

  try {
    $versionLine = (& $ExePath -hide_banner -version 2>&1 | Select-Object -First 1) -join ''
  } catch {
    $versionLine = ''
  }

  try {
    $devicesOutput = (& $ExePath -hide_banner -devices 2>&1 | Out-String)
  } catch {
    $devicesOutput = ''
  }

  $devices = @()
  $inTable = $false
  foreach ($rawLine in ($devicesOutput -split "`r?`n")) {
    $line = $rawLine.Trim()
    if (-not $line) {
      continue
    }

    if ($line -eq '---') {
      $inTable = $true
      continue
    }

    if (-not $inTable) {
      continue
    }

    $parts = $line -split '\s+'
    if ($parts.Count -lt 2) {
      continue
    }

    $flags = $parts[0]
    $name = $parts[1]
    if ($flags -notmatch 'D' -or $name -eq '=') {
      continue
    }

    $devices += $name
  }

  [pscustomobject]@{
    ExePath = $ExePath
    VersionLine = $versionLine
    Devices = @($devices | Select-Object -Unique)
  }
}

function Get-FfmpegScore {
  param(
    [Parameter(Mandatory = $true)]
    $Metadata
  )

  $score = 0
  if ($Metadata.Devices -contains 'gdigrab') { $score += 100 }
  if ($Metadata.Devices -contains 'dshow') { $score += 40 }
  if ($Metadata.VersionLine -match 'N-') { $score += 25 }
  if ($Metadata.ExePath -match 'latest') { $score += 20 }
  if ($Metadata.ExePath -match 'master') { $score += 10 }
  if ($Metadata.ExePath -match 'shared') { $score += 5 }
  return $score
}

Write-Host "Building vds-media-agent ($Configuration)..."

$ffmpegSdkSearchRoots = @()
if ($FfmpegSourceRoot) {
  $ffmpegSdkSearchRoots += $FfmpegSourceRoot
}
$ffmpegSdkSearchRoots += 'D:\project\publicresource\ffmpeg-master-latest-win64-gpl-shared'
$ffmpegSdkSearchRoots += 'D:\project\publicresource'
$resolvedFfmpegRoot = Resolve-FfmpegSdkRoot -SearchRoots $ffmpegSdkSearchRoots
if (-not $resolvedFfmpegRoot) {
  throw 'Unable to locate an FFmpeg SDK root with include/ and lib/ for media-agent build. Set VDS_FFMPEG_SOURCE to a shared FFmpeg build.'
}
Write-Host "Using FFmpeg SDK root: $resolvedFfmpegRoot"

if (Test-Path $buildDir) {
  $cmakeCachePath = Join-Path $buildDir 'CMakeCache.txt'
  if (Test-Path $cmakeCachePath) {
    Remove-Item $cmakeCachePath -Force
  }
}

$cmakeArgs = @(
  '-S', $sourceDir,
  '-B', $buildDir,
  '-A', 'x64',
  "-DVDS_MEDIA_AGENT_ENABLE_LIBDATACHANNEL=$libDataChannelOption",
  "-DVDS_MEDIA_AGENT_FFMPEG_ROOT=$resolvedFfmpegRoot"
)

if ($enableLibDataChannel) {
  $cmakeArgs += "-DCMAKE_TOOLCHAIN_FILE=$vcpkgToolchain"
  $cmakeArgs += '-DVCPKG_TARGET_TRIPLET=x64-windows'
  $cmakeArgs += "-DVCPKG_MANIFEST_DIR=$sourceDir"
  Write-Host "Enabling libdatachannel backend with vcpkg toolchain: $vcpkgToolchain"
} else {
  Write-Warning 'vcpkg toolchain not found; building media-agent without libdatachannel backend.'
}

cmake @cmakeArgs | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "cmake configure failed with exit code $LASTEXITCODE"
}

cmake --build $buildDir --config $Configuration | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "cmake build failed with exit code $LASTEXITCODE"
}

$candidatePaths = @(
  (Join-Path $buildDir "$Configuration\vds-media-agent.exe"),
  (Join-Path $buildDir 'vds-media-agent.exe')
)

$builtBinary = $candidatePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $builtBinary) {
  throw "Unable to locate built vds-media-agent.exe under $buildDir"
}

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$runtimeBinary = Join-Path $runtimeDir 'vds-media-agent.exe'
Copy-Item $builtBinary $runtimeBinary -Force

Write-Host "Copied agent binary to $runtimeBinary"

if ($enableLibDataChannel) {
  $runtimeLibNames = @(
    'datachannel.dll',
    'juice.dll',
    'libcrypto-3-x64.dll',
    'libssl-3-x64.dll',
    'srtp2.dll'
  )
  foreach ($runtimeLibName in $runtimeLibNames) {
    $runtimeLibSource = @(
      (Join-Path $buildDir "vcpkg_installed\x64-windows\bin\$runtimeLibName"),
      (Join-Path $vcpkgRoot "installed\x64-windows\bin\$runtimeLibName")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (Test-Path $runtimeLibSource) {
      Copy-Item $runtimeLibSource (Join-Path $runtimeDir $runtimeLibName) -Force
      Write-Host "Copied libdatachannel runtime dependency: $runtimeLibName"
    } else {
      Write-Warning "Expected libdatachannel runtime dependency not found: $runtimeLibName"
    }
  }
}

$ffmpegSearchRoots = @($resolvedFfmpegRoot)
if ($FfmpegSourceRoot) {
  $ffmpegSearchRoots += $FfmpegSourceRoot
}
$ffmpegSearchRoots += 'D:\project\publicresource'
$ffmpegSearchRoots = $ffmpegSearchRoots | Where-Object { $_ } | Select-Object -Unique

$ffmpegCandidates = @()
foreach ($searchRoot in $ffmpegSearchRoots) {
  if (-not (Test-Path $searchRoot)) {
    continue
  }

  $ffmpegCandidates += Get-ChildItem -Path $searchRoot -Recurse -File -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName
}

$ffmpegCandidates = $ffmpegCandidates | Select-Object -Unique
if (-not $ffmpegCandidates -or $ffmpegCandidates.Count -eq 0) {
  Write-Warning "Unable to locate ffmpeg.exe. Set VDS_FFMPEG_SOURCE if you want to package FFmpeg with the media agent."
  return
}

$ffmpegMetadata = foreach ($candidate in $ffmpegCandidates) {
  Get-FfmpegMetadata -ExePath $candidate
}

$selectedFfmpeg = $ffmpegMetadata |
  Sort-Object @{ Expression = { Get-FfmpegScore $_ }; Descending = $true }, @{ Expression = { $_.ExePath }; Descending = $false } |
  Select-Object -First 1

if (-not $selectedFfmpeg) {
  Write-Warning "Unable to evaluate FFmpeg candidates under the configured search roots."
  return
}

$ffmpegExe = $selectedFfmpeg.ExePath
$selectedScore = Get-FfmpegScore $selectedFfmpeg
Write-Host "Selected FFmpeg runtime: $ffmpegExe"
Write-Host "FFmpeg selection score: $selectedScore"
if ($selectedFfmpeg.VersionLine) {
  Write-Host "FFmpeg version line: $($selectedFfmpeg.VersionLine)"
}
if ($selectedFfmpeg.Devices.Count -gt 0) {
  Write-Host "FFmpeg input devices: $($selectedFfmpeg.Devices -join ', ')"
}

$ffmpegBinDir = Split-Path -Parent $ffmpegExe
New-Item -ItemType Directory -Force -Path $runtimeFfmpegBinDir | Out-Null
Copy-Item (Join-Path $ffmpegBinDir '*') $runtimeFfmpegBinDir -Force

Write-Host "Copied FFmpeg runtime from $ffmpegBinDir to $runtimeFfmpegBinDir"

Get-ChildItem -Path $ffmpegBinDir -Filter '*.dll' -File -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $runtimeDir $_.Name) -Force
  Write-Host "Copied agent FFmpeg dependency: $($_.Name)"
}
