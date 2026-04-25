$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$targets = @(
  @{ Path = 'server\public'; Include = @('*.js') },
  @{ Path = 'server\server-core.js'; Include = @('*.js') },
  @{ Path = 'desktop'; Include = @('*.js') },
  @{ Path = 'media-agent\src'; Include = @('*.cpp', '*.h') }
)

$logPattern = 'console\.(log|warn|error|debug)\b|std::(cerr|cout)\b'
$violations = New-Object System.Collections.Generic.List[string]

function Get-RelativePath([string] $path) {
  $fullPath = (Resolve-Path $path).Path
  if ($fullPath.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')
  }
  return $fullPath.Replace('\', '/')
}

function Test-AllowedLog([string] $relativePath, [string] $line, [string] $context) {
  switch -Regex ($relativePath) {
    '^server/server-core\.js$' {
      return (
        $line -match 'console\.log\(\.\.\.args\)' -or
        $line -match 'console\.log\(`Server running on http://localhost:' -or
        ($context -match 'function logServerWarning' -and $line -match 'console\.error\(') -or
        $line -match "console\.error\('Invalid ICE_SERVERS_JSON:'"
      )
    }
    '^server/public/app\.js$' {
      return $line -match 'console\.log\(\.\.\.resolvedArgs\)'
    }
    '^server/public/app-native-overrides\.js$' {
      return (
        ($context -match 'function logNativeDebug' -and $line -match 'console\.log') -or
        ($context -match 'function logNativeStep' -and $line -match 'console\.log') -or
        ($context -match 'function logNativeStatsLine' -and $line -match 'console\.log') -or
        ($context -match 'function logNativeWarningLine' -and $line -match 'console\.warn') -or
        ($context -match 'function logNativeMediaEngineEventSummary' -and $line -match 'console\.log') -or
        $line -match "console\.error\('\[media-engine\] native override init failed:'"
      )
    }
    '^desktop/main\.js$' {
      return (
        ($context -match 'function logMainProcessDebug' -and $line -match 'console\.log') -or
        ($context -match 'function logMainProcessWarning' -and $line -match 'console\.warn') -or
        $line -match "console\.error\('Update check error:'" -or
        $line -match "console\.error\('Update download error:'" -or
        $line -match "console\.error\('\[media-agent\] Failed to stop during quit:'" -or
        $line -match "console\.error\('\[media-agent\] Failed to stop before quit:'" -or
        $line -match "console\.error\('\[update-log\] Failed to persist update log:'" -or
        $line -match 'console\.error\(\.\.\.args\)' -or
        $line -match 'console\.error\(`\[media-agent\] \$\{method\} failed:`' -or
        $line -match 'console\.error\(`\[media-agent bridge\] \$\{method\} failed:`'
      )
    }
    '^media-agent/src/agent_events\.cpp$' {
      return $line -match 'std::cout'
    }
    '^media-agent/src/agent_diagnostics\.cpp$' {
      return $line -match 'std::cerr'
    }
    default {
      return $false
    }
  }
}

foreach ($target in $targets) {
  $targetPath = Join-Path $repoRoot $target.Path
  if (-not (Test-Path $targetPath)) {
    continue
  }

  $files = if ((Get-Item $targetPath).PSIsContainer) {
    Get-ChildItem -Path $targetPath -Recurse -File -Include $target.Include
  } else {
    @(Get-Item $targetPath)
  }

  foreach ($file in $files) {
    $relativePath = Get-RelativePath $file.FullName
    $matches = Select-String -Path $file.FullName -Pattern $logPattern -Context 30, 30
    foreach ($match in $matches) {
      $context = @(
        $match.Context.PreContext
        $match.Line
        $match.Context.PostContext
      ) -join "`n"

      if (-not (Test-AllowedLog $relativePath $match.Line $context)) {
        $violations.Add("${relativePath}:$($match.LineNumber): $($match.Line.Trim())")
      }
    }
  }
}

if ($violations.Count -gt 0) {
  Write-Error ("Logging policy violations:`n" + ($violations -join "`n") + "`nUse the logging wrappers documented in docs/LOGGING_DEBUG_SYSTEM.md.")
}

Write-Host 'Logging policy check passed.'
