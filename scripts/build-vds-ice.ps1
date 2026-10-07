param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [string]$VcpkgRoot = $env:VCPKG_ROOT,
  [string]$DependencyPrefix,
  [switch]$SkipRuntimeCopy
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$iceRoot = Join-Path $repoRoot 'media-agent\build\vds-ice'
$patchRoot = Join-Path $repoRoot 'media-agent\third_party\ice-patches'
$installRoot = Join-Path $iceRoot 'installed'
if (-not $VcpkgRoot -and (Test-Path -LiteralPath 'C:\vcpkg')) { $VcpkgRoot = 'C:\vcpkg' }
if (-not $VcpkgRoot) { throw 'Set VCPKG_ROOT for the existing OpenSSL/usrsctp/SRTP dependencies.' }
if (-not $DependencyPrefix) {
  $DependencyPrefix = Join-Path $repoRoot 'media-agent\build\vcpkg_installed\x64-windows'
  if (-not (Test-Path -LiteralPath (Join-Path $DependencyPrefix 'share\unofficial-usrsctp'))) {
    $DependencyPrefix = Join-Path $VcpkgRoot 'installed\x64-windows'
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $DependencyPrefix 'share\unofficial-usrsctp'))) {
  throw 'Build/install the media-agent vcpkg manifest dependencies first.'
}

function Invoke-Checked {
  param([string]$Program, [string[]]$Arguments)
  & $Program @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

$sources = @(
  @{ Name = 'libjuice'; Version = '1.7.0'; Hash = '20800c54231188982f75bf823e1a450c6e501247fdb7348f4dc1dfaee6c6bf1394b681cd7e576156ddf2a1936668ebda10a1e74b9778f5bdd2a46c26173b68ac' },
  @{ Name = 'libdatachannel'; Version = '0.24.1'; Hash = '8731997a8923c96f80553fffa208204568ed7b7ed8a73d1c7dcc56ec8514809e2dafecde9c297668337efbe08e570c40d9f484d6fe3b784129ba86883efbb277' }
)
New-Item -ItemType Directory -Force -Path $iceRoot, $installRoot | Out-Null
$buildStampParts = @()
foreach ($source in $sources) {
  $name = $source.Name
  $version = $source.Version
  $patchPath = Join-Path $patchRoot "$name-$version-vds.patch"
  $patchHash = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.Substring(0, 12)
  $algorithmHash = (Get-FileHash -LiteralPath (Join-Path $repoRoot 'media-agent\src\nat_port_prediction.h') -Algorithm SHA256).Hash.Substring(0, 12)
  $revision = "$version-$patchHash-$algorithmHash"
  $buildStampParts += "$name=$revision"
  $archiveName = "paullouisageneau-$name-v$version.tar.gz"
  $archivePath = Join-Path $VcpkgRoot "downloads\$archiveName"
  if (-not (Test-Path -LiteralPath $archivePath)) {
    $archivePath = Join-Path $iceRoot $archiveName
    if (-not (Test-Path -LiteralPath $archivePath)) {
      Invoke-WebRequest -Uri "https://github.com/paullouisageneau/$name/archive/refs/tags/v$version.tar.gz" -OutFile $archivePath
    }
  }
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA512).Hash -ne $source.Hash) {
    throw "Pinned source hash mismatch: $archivePath"
  }
  $sourceParent = Join-Path $iceRoot "sources\$name-$revision"
  $sourcePath = Join-Path $sourceParent "$name-$version"
  $patchMarker = Join-Path $sourceParent '.vds-patch-applied'
  if (-not (Test-Path -LiteralPath $patchMarker)) {
    if (Test-Path -LiteralPath $sourceParent) {
      # Only incomplete task-owned source extraction may be removed, within build/vds-ice.
      $resolved = (Resolve-Path -LiteralPath $sourceParent).Path
      $allowedRoot = [IO.Path]::GetFullPath($iceRoot).TrimEnd('\') + '\'
      if (-not $resolved.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove source directory outside task build root: $resolved"
      }
      Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $sourceParent | Out-Null
    Invoke-Checked -Program 'tar' -Arguments @('-xf', $archivePath, '-C', $sourceParent)
    Invoke-Checked -Program 'git' -Arguments @('-C', $sourcePath, 'apply', '--check', $patchPath)
    Invoke-Checked -Program 'git' -Arguments @('-C', $sourcePath, 'apply', $patchPath)
    Set-Content -LiteralPath $patchMarker -Value $revision -Encoding utf8
  }
  $buildPath = Join-Path $iceRoot "build\$name-$revision"
  $configureArgs = @(
    '-S', $sourcePath, '-B', $buildPath, '-G', 'Visual Studio 17 2022', '-A', 'x64',
    "-DCMAKE_INSTALL_PREFIX=$installRoot", '-DBUILD_SHARED_LIBS=ON', '-DNO_TESTS=ON'
  )
  if ($name -eq 'libjuice') {
    $configureArgs += '-DNO_SERVER=ON'
    $configureArgs += "-DVDS_NAT_PREDICTION_INCLUDE_DIR=$(Join-Path $repoRoot 'media-agent\src')"
  } else {
    $configureArgs += @(
      '-DPREFER_SYSTEM_LIB=ON', '-DNO_EXAMPLES=ON', '-DUSE_NICE=OFF',
      '-DUSE_SYSTEM_JUICE=ON', '-DUSE_SYSTEM_PLOG=ON', '-DUSE_SYSTEM_JSON=ON',
      '-DUSE_SYSTEM_USRSCTP=ON', '-DUSE_SYSTEM_SRTP=ON', '-DNO_MEDIA=OFF', '-DNO_WEBSOCKET=OFF',
      "-DCMAKE_PREFIX_PATH=$installRoot;$DependencyPrefix",
      "-DLibJuice_DIR=$(Join-Path $installRoot 'lib\cmake\LibJuice')",
      "-DJUICE_INCLUDE_DIR=$(Join-Path $installRoot 'include')",
      "-DJUICE_LIBRARY=$(Join-Path $installRoot 'lib\juice.lib')",
      "-DOPENSSL_ROOT_DIR=$DependencyPrefix"
    )
  }
  Invoke-Checked -Program 'cmake' -Arguments $configureArgs
  Invoke-Checked -Program 'cmake' -Arguments @('--build', $buildPath, '--config', $Configuration, '--parallel', '4')
  Invoke-Checked -Program 'cmake' -Arguments @('--install', $buildPath, '--config', $Configuration)
}
Set-Content -LiteralPath (Join-Path $installRoot 'vds-enhanced-ice.txt') -Value ($buildStampParts -join "`n") -Encoding utf8
if (-not $SkipRuntimeCopy) {
  $runtimeRoot = Join-Path $repoRoot 'runtime\media-agent'
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  foreach ($dll in @('juice.dll', 'datachannel.dll')) {
    Copy-Item -LiteralPath (Join-Path $installRoot "bin\$dll") -Destination (Join-Path $runtimeRoot $dll) -Force
  }
}
Write-Host "VDS enhanced ICE built: $installRoot"
