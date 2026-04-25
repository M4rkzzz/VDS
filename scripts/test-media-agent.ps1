param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$buildDir = Join-Path $repoRoot 'media-agent\build'

if (-not (Test-Path $buildDir)) {
  throw "media-agent build directory not found: $buildDir. Run npm run build:media-agent first."
}

ctest --test-dir $buildDir -C $Configuration --output-on-failure
if ($LASTEXITCODE -ne 0) {
  throw "media-agent tests failed with exit code $LASTEXITCODE"
}
