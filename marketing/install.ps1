# CataBull installer for Windows (PowerShell 5.1+).
#
# Usage:
#   irm https://nerdywhiskers.github.io/CataBull/install.ps1 | iex
#
# What it does:
#   1. Detect Node 18+. If missing, install fnm + Node 22 (no admin needed).
#   2. Resolve the latest deployed GitHub Release tag (fallback: main).
#   3. npm install -g github:nerdywhiskers/CataBull#<release-tag-or-main>
#   4. catabull setup  (installs Playwright Chromium into user cache)
#
# Environment overrides:
#   $env:CATABULL_REPO       -- github:<owner>/<repo> source
#   $env:CATABULL_REF        -- explicit git ref/tag to install (skips GitHub release lookup)
#   $env:CATABULL_NODE_MAJOR -- Node major version to install if missing
#   $env:CATABULL_SKIP_SETUP -- set to '1' to skip the post-install setup

$ErrorActionPreference = 'Stop'

$Repo          = if ($env:CATABULL_REPO)       { $env:CATABULL_REPO }       else { 'nerdywhiskers/CataBull' }
$Ref           = if ($env:CATABULL_REF)        { $env:CATABULL_REF }        else { $null }
$MinNodeMajor  = 18
$NodeMajor     = if ($env:CATABULL_NODE_MAJOR) { [int]$env:CATABULL_NODE_MAJOR } else { 22 }
$FnmInstallDir = Join-Path $env:LOCALAPPDATA 'fnm'

function Say  ([string]$msg) { Write-Host $msg -ForegroundColor White }
function Hint ([string]$msg) { Write-Host $msg -ForegroundColor DarkGray }
function Warn ([string]$msg) { Write-Host $msg -ForegroundColor Yellow }
function Fail ([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

Say  "CataBull installer"
Hint "Source: github:$Repo"
Write-Host ''

if (-not $Ref) {
  Say '-> Resolving latest deployed release'
  try {
    $latest = Invoke-RestMethod -Headers @{ Accept = 'application/vnd.github+json' } -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $Ref = $latest.tag_name
  } catch {
    $Ref = 'main'
    Warn "No published GitHub Release found for $Repo yet -- falling back to main."
  }
  if (-not $Ref) { Fail "Latest GitHub Release for $Repo did not return a tag name." }
}
Hint "Release ref: $Ref"

# Refresh the current session's PATH from the registry so anything we
# install/modify lands on PATH without requiring a new shell.
function Update-PathFromRegistry {
  # Refreshes $env:Path from the registry so we pick up just-installed tools
  # (fnm, uv, etc.) without opening a new PowerShell window.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = ($machine, $user, $env:Path) -join ';'
}

# --- 1. Node detection ---
$haveNode = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  try {
    $nodeVer = & node -v
    if ($nodeVer -match '^v(\d+)') {
      $currentMajor = [int]$Matches[1]
      if ($currentMajor -ge $MinNodeMajor) {
        Say "OK Node $nodeVer detected"
        $haveNode = $true
      } else {
        Hint "Node $nodeVer detected, but CataBull needs >= v$MinNodeMajor"
      }
    }
  } catch {
    Hint "Node detection failed: $($_.Exception.Message)"
  }
}

# --- 2. Install Node via fnm if missing ---
if (-not $haveNode) {
  $fnmCmd = Get-Command fnm -ErrorAction SilentlyContinue
  if (-not $fnmCmd) {
    Say "-> Installing fnm (Fast Node Manager -- no admin required)"

    # Pull the latest fnm-windows zip from GitHub releases. We use the
    # x64 build -- armv7/aarch64 Windows users will need to install Node
    # themselves (rare enough not to special-case yet).
    $asset   = 'fnm-windows.zip'
    $release = 'https://github.com/Schniz/fnm/releases/latest/download'
    $zipPath = Join-Path $env:TEMP "fnm-catabull.zip"

    Invoke-WebRequest -UseBasicParsing -Uri "$release/$asset" -OutFile $zipPath
    New-Item -ItemType Directory -Force -Path $FnmInstallDir | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $FnmInstallDir -Force
    Remove-Item -Force $zipPath

    # Persist fnm on the user PATH so future shells find it. Idempotent
    # -- only appends if it isn't already in there.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath -or ($userPath -split ';' -notcontains $FnmInstallDir)) {
      $newPath = if ($userPath) { "$userPath;$FnmInstallDir" } else { $FnmInstallDir }
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
    Update-PathFromRegistry

    $fnmCmd = Get-Command fnm -ErrorAction SilentlyContinue
    if (-not $fnmCmd) { Fail "fnm installed but not on PATH. Open a new PowerShell window and re-run this installer." }
  }

  Say "-> Installing Node $NodeMajor via fnm"
  & fnm install $NodeMajor | Out-Null
  & fnm default $NodeMajor | Out-Null

  # Wire fnm's shims into this PowerShell session.
  $fnmEnv = & fnm env --use-on-cd --shell powershell
  Invoke-Expression $fnmEnv

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { Fail "Node install succeeded but node is still not on PATH. Restart PowerShell and retry." }
  Say "OK Node $(& node -v) ready"
}

# --- 3. Install catabull globally from GitHub ---
Say "-> Installing catabull from github:$Repo#$Ref"
& npm install -g "github:$Repo#$Ref" | Out-Null

$catabullCmd = Get-Command catabull -ErrorAction SilentlyContinue
if (-not $catabullCmd) { Fail "catabull installed but not on PATH. Try restarting PowerShell, then run 'catabull'." }

try { $cbVer = & catabull --version } catch { $cbVer = 'installed' }
Say "OK catabull $cbVer"

# --- 4. Optional: install uv for JobSpy (Deep Scan Level 4) ---
if ($env:CATABULL_SKIP_JOBSPY -ne '1') {
  $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
  $pyCmd = Get-Command python -ErrorAction SilentlyContinue
  $py3Cmd = Get-Command python3 -ErrorAction SilentlyContinue
  if (-not $uvCmd -and -not $pyCmd -and -not $py3Cmd) {
    Say "-> Installing uv (Python runner for JobSpy aggregator scans)"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri 'https://astral.sh/uv/install.ps1' | Invoke-Expression
      Update-PathFromRegistry
      $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
      if ($uvCmd) {
        Say "OK uv ready"
      } else {
        Warn "uv install reported success but uv isn't on PATH. JobSpy Level 4 will be unavailable; re-run after opening a new PowerShell window."
      }
    } catch {
      Warn "uv install failed -- $($_.Exception.Message). JobSpy Level 4 will be unavailable until you install uv or python."
    }
  }
}

# --- 5. Run first-run setup ---
if ($env:CATABULL_SKIP_SETUP -ne '1') {
  Say "-> Running first-run setup (downloads Playwright Chromium on first install)"
  try {
    & catabull setup
  } catch {
    Warn "Setup reported issues -- try 'catabull doctor' to debug."
  }
}

# --- 5. Done ---
Write-Host ''
Say "OK CataBull installed"
Write-Host ''
Write-Host "  Start the dashboard:   " -NoNewline; Write-Host "catabull" -ForegroundColor Cyan
Write-Host "  Then open:             http://localhost:3737"
Write-Host ''
if (-not $haveNode) {
  Hint "If 'catabull' isn't found in a new PowerShell window, close and reopen it once to pick up the updated PATH."
}
