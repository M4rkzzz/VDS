param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ElectronArgs = @('.')
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$electronCmd = Join-Path $repoRoot 'node_modules\.bin\electron.cmd'
if (-not (Test-Path $electronCmd)) {
  throw "Electron binary was not found at $electronCmd. Run npm install first."
}

& $electronCmd @ElectronArgs
exit $LASTEXITCODE
