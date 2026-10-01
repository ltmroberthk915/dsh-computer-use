# run-guards.ps1 — run EVERY guard in build/ from the repo root and report one verdict.
#
# Why this exists: the guards were only ever run by hand, one path at a time, from whatever the
# current directory happened to be — and two of them resolve `../packages/...` against the WORKING
# DIRECTORY, so running them from elsewhere failed with ENOENT on a path that does not exist. A
# safety net nobody runs (or that "fails" for a reason unrelated to the code) is decoration.
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File <repo>\build\run-guards.ps1
#
# Exit code 0 = every guard passed. 1 = at least one failed (the failing names are printed last).
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
Push-Location $repo
try {
  $passed = 0; $failed = New-Object System.Collections.Generic.List[string]
  $guards = Get-ChildItem (Join-Path $PSScriptRoot 'test-*.mjs') | Sort-Object Name
  foreach ($g in $guards) {
    $out = & node (Join-Path 'build' $g.Name) 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      $passed++
      $line = ($out | Where-Object { $_ -match '^ok ' } | Select-Object -Last 1)
      Write-Host ("  ok    {0}" -f $g.Name) -ForegroundColor Green
      if ($line) { Write-Host ("        {0}" -f $line.Substring(0, [Math]::Min(150, $line.Length))) -ForegroundColor DarkGray }
    } else {
      $failed.Add($g.Name)
      Write-Host ("  FAIL  {0}  (exit {1})" -f $g.Name, $code) -ForegroundColor Red
      # Show the guard's OWN words. It does not always prefix them with "FAIL" (a self-test BUG, a
      # mutation that could not be constructed), so print the tail rather than a filtered guess —
      # a runner that hides the reason is how a real failure gets read as noise.
      $tail = @($out | Where-Object { $_ -and $_.ToString().Trim().Length -gt 0 } | Select-Object -Last 5)
      foreach ($l in $tail) { Write-Host ("        {0}" -f $l.ToString().Trim()) -ForegroundColor DarkRed }
    }
  }
  Write-Host ""
  if ($failed.Count -gt 0) {
    Write-Host ("FAIL run-guards — {0} passed, {1} failed: {2}" -f $passed, $failed.Count, ($failed -join ', ')) -ForegroundColor Red
    exit 1
  }
  Write-Host ("ok run-guards — all {0} guards passed (run from {1})" -f $passed, $repo) -ForegroundColor Green
  exit 0
} finally { Pop-Location }
