param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Release',
  [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$projectPath = Join-Path $repoRoot 'tools\TestLauncher\TestLauncher.csproj'
$outputDir = Join-Path $repoRoot 'dist\tools'
$publishDir = Join-Path $repoRoot "tools\TestLauncher\bin\$Configuration\net9.0-windows\$Runtime\publish"

Push-Location $repoRoot
try {
  dotnet publish $projectPath `
    -c $Configuration `
    -r $Runtime `
    --self-contained false `
    /p:PublishSingleFile=true `
    /p:PublishReadyToRun=false `
    /p:DebugType=none `
    /p:DebugSymbols=false

  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
  $targetPath = Join-Path $outputDir 'VDS-Test-Launcher.exe'
  try {
    Copy-Item -LiteralPath (Join-Path $publishDir 'VDS-Test-Launcher.exe') -Destination $targetPath -Force
    Write-Host "Test launcher built: $targetPath"
  } catch {
    $fallbackPath = Join-Path $outputDir 'VDS-Test-Launcher.updated.exe'
    Copy-Item -LiteralPath (Join-Path $publishDir 'VDS-Test-Launcher.exe') -Destination $fallbackPath -Force
    Write-Warning "Could not overwrite $targetPath because it is in use. Wrote updated launcher to $fallbackPath"
  }
} finally {
  Pop-Location
}
