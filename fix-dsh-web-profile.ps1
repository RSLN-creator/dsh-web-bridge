<#
  fix-dsh-web-profile.ps1
  Repair the DSH web profile after ERR_PNPM_UNUSED_PATCH.

  Cause: dsh-loopx-plugin was removed from package.json (dependencies + bundles),
         but its patchedDependencies entry in pnpm-workspace.yaml and the patch
         file under patches/ were left behind. pnpm 11 aborts with
         ERR_PNPM_UNUSED_PATCH when a declared patch matches no package in the
         graph, so every pnpm operation in this profile fails -- which is why
         dshmarket could neither update @liustack/modsearch nor uninstall
         @opencode2dsh/dsh-plugin.

  This script is DRY-RUN by default. Add -Apply to actually write.

  Usage:
    powershell -File .\fix-dsh-web-profile.ps1
    powershell -File .\fix-dsh-web-profile.ps1 -Apply
    powershell -File .\fix-dsh-web-profile.ps1 -Apply -SkipInstall
#>
[CmdletBinding()]
param(
  [string]$ProfilePath = 'C:\Users\rsyhn\.dsh\profiles\web',
  [switch]$Apply,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step([string]$m) { Write-Host "" ; Write-Host "=== $m" -ForegroundColor Cyan }

if (-not (Test-Path $ProfilePath)) { throw "profile not found: $ProfilePath" }
$ws         = Join-Path $ProfilePath 'pnpm-workspace.yaml'
$pkg        = Join-Path $ProfilePath 'package.json'
$patchDir   = Join-Path $ProfilePath 'patches'
$marketSt   = Join-Path $ProfilePath '.dsh-market\state.json'

$mode = 'DRY-RUN (preview only)'
if ($Apply) { $mode = 'APPLY (files will be written)' }
Say "profile : $ProfilePath"
Say "mode    : $mode" $(if ($Apply) { 'Yellow' } else { 'Green' })

# ---------- 0. sanity check ----------
Step '0. Sanity check'
if ((Get-Content $pkg -Raw) -match 'dsh-loopx-plugin') {
  Say '  [!] package.json still references dsh-loopx-plugin.' 'Red'
  Say '      If you want to keep the plugin, the fix is to re-run pnpm install' 'Red'
  Say '      so it re-enters the graph -- not to delete the patch.' 'Red'
} else {
  Say '  [ok] package.json has no dsh-loopx-plugin (residue confirmed)' 'Green'
}

# ---------- 1. drop the dangling patchedDependencies block ----------
Step '1. pnpm-workspace.yaml -> remove dangling patchedDependencies'
if (-not (Test-Path $ws)) { Say '  [skip] file not found' 'DarkGray' }
else {
  $wsText = [System.IO.File]::ReadAllText($ws).TrimStart([char]0xFEFF)
  $lines  = $wsText -split "`r?`n"
  $out    = New-Object System.Collections.Generic.List[string]
  $skipping = $false
  $removed  = 0
  foreach ($line in $lines) {
    if ($line -match '^patchedDependencies\s*:') { $skipping = $true; $removed++; continue }
    if ($skipping) {
      if ($line -match '^\s' -or $line -match '^\s*$') { $removed++; continue }
      $skipping = $false
    }
    $out.Add($line)
  }
  while ($out.Count -gt 0 -and $out[$out.Count - 1] -match '^\s*$') { $out.RemoveAt($out.Count - 1) }
  $newText = ($out -join "`r`n") + "`r`n"

  Say "  removing $removed line(s). Preview:" 'Yellow'
  foreach ($l in ($newText -split "`r?`n")) { Say "    | $l" 'DarkGray' }

  if ($Apply) {
    Copy-Item $ws "$ws.bak-$stamp-loopxfix" -Force
    Say "  backup -> $ws.bak-$stamp-loopxfix" 'DarkGray'
    [System.IO.File]::WriteAllText($ws, $newText, (New-Object System.Text.UTF8Encoding($false)))
    Say '  [done] written' 'Green'
  } else { Say '  [dry-run] not written' 'DarkGray' }
}

# ---------- 2. disable the patch file ----------
Step '2. patches/ -> disable loopx patch'
if (Test-Path $patchDir) {
  $pf = Get-ChildItem $patchDir -Filter '*loopx*' -File -ErrorAction SilentlyContinue
  if (-not $pf) { Say '  [skip] no loopx patch file' 'DarkGray' }
  foreach ($f in $pf) {
    if ($Apply) {
      Rename-Item $f.FullName "$($f.Name).disabled" -Force
      Say "  [done] $($f.Name) -> $($f.Name).disabled" 'Green'
    } else { Say "  [dry-run] would rename $($f.Name) -> $($f.Name).disabled" 'DarkGray' }
  }
} else { Say '  [skip] patches directory not found' 'DarkGray' }

# ---------- 3. clean stale market state ----------
Step '3. .dsh-market/state.json -> drop dsh-loopx-plugin'
if (-not (Test-Path $marketSt)) { Say '  [skip] file not found' 'DarkGray' }
else {
  $st = Get-Content $marketSt -Raw | ConvertFrom-Json
  $before = @($st.disabled)
  Say "  disabled now: $($before -join ', ')" 'DarkGray'
  if ($before -contains 'dsh-loopx-plugin') {
    $st.disabled = @($before | Where-Object { $_ -ne 'dsh-loopx-plugin' })
    $json = $st | ConvertTo-Json -Compress -Depth 10
    Say "  disabled new: $($st.disabled -join ', ')" 'Yellow'
    if ($Apply) {
      Copy-Item $marketSt "$marketSt.bak-$stamp" -Force
      [System.IO.File]::WriteAllText($marketSt, $json, (New-Object System.Text.UTF8Encoding($false)))
      Say '  [done] written' 'Green'
    } else { Say '  [dry-run] not written' 'DarkGray' }
  } else { Say '  [skip] entry not present' 'DarkGray' }
}

# ---------- 4. verify with pnpm install ----------
Step '4. pnpm install (verification)'
if ($SkipInstall) { Say '  [skip] -SkipInstall' 'DarkGray' }
elseif (-not $Apply) { Say '  [dry-run] skipped; run with -Apply to execute' 'DarkGray' }
else {
  Say '  NOTE: close all running DSH sessions/agents first, or pnpm may fail on locked files.' 'Yellow'
  Push-Location $ProfilePath
  $code = 1
  try {
    pnpm install 2>&1 | ForEach-Object { Say "    $_" 'DarkGray' }
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  if ($code -eq 0) { Say '  [done] pnpm install succeeded -- the lock is cleared' 'Green' }
  else { Say "  [fail] pnpm install exit code $code -- send the output above to the maintainer" 'Red' }
}

# ---------- 5. next steps ----------
Step '5. Next steps'
Say '  * Retry in the plugin market: update @liustack/modsearch, uninstall @opencode2dsh/dsh-plugin.' 'Gray'
Say '  * After uninstalling a PATCHED plugin, check pnpm-workspace.yaml for a leftover' 'Gray'
Say '    patchedDependencies entry -- that is exactly what broke this profile.' 'Gray'
Say '  * The *.bak-* files in the profile can be archived; see the cleanup list in the report.' 'Gray'
Say ''
Say "(backup suffix: -$stamp)"