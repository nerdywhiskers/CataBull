# CareerBot installer for Windows (PowerShell 5.1+).
#
# Usage:
#   irm https://your-github-user.github.io/careerbot/install.ps1 | iex
#
# What it does:
#   1. Detect Node 18+. If missing, install fnm + Node 22 (no admin needed).
#   2. npm install -g github:your-github-user/careerbot
#   3. careerbot setup  (installs Playwright Chromium into user cache)
#
# Environment overrides:
#   $env:CAREERBOT_REPO       -- github:<owner>/<repo> source
#   $env:CAREERBOT_NODE_MAJOR -- Node major version to install if missing
#   $env:CAREERBOT_SKIP_SETUP -- set to '1' to skip the post-install setup

$ErrorActionPreference = 'Stop'

$Repo          = if ($env:CAREERBOT_REPO)       { $env:CAREERBOT_REPO }       else { 'your-github-user/careerbot' }
$MinNodeMajor  = 18
$NodeMajor     = if ($env:CAREERBOT_NODE_MAJOR) { [int]$env:CAREERBOT_NODE_MAJOR } else { 22 }
$FnmInstallDir = Join-Path $env:LOCALAPPDATA 'fnm'

function Say  ([string]$msg) { Write-Host $msg -ForegroundColor White }
function Hint ([string]$msg) { Write-Host $msg -ForegroundColor DarkGray }
function Warn ([string]$msg) { Write-Host $msg -ForegroundColor Yellow }
function Fail ([string]$msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

Say  "CareerBot installer"
Hint "Source: github:$Repo"
Write-Host ''

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
        Hint "Node $nodeVer detected, but CareerBot needs >= v$MinNodeMajor"
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
    $zipPath = Join-Path $env:TEMP "fnm-careerbot.zip"

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

# --- 3. Install careerbot globally from GitHub ---
Say "-> Installing careerbot from github:$Repo"
& npm install -g "github:$Repo" | Out-Null

$careerbotCmd = Get-Command careerbot -ErrorAction SilentlyContinue
if (-not $careerbotCmd) { Fail "careerbot installed but not on PATH. Try restarting PowerShell, then run 'careerbot'." }

try { $cbVer = & careerbot --version } catch { $cbVer = 'installed' }
Say "OK careerbot $cbVer"

# --- 4. Optional: install uv for JobSpy (Deep Scan Level 4) ---
if ($env:CAREERBOT_SKIP_JOBSPY -ne '1') {
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
if ($env:CAREERBOT_SKIP_SETUP -ne '1') {
  Say "-> Running first-run setup (downloads Playwright Chromium on first install)"
  try {
    & careerbot setup
  } catch {
    Warn "Setup reported issues -- try 'careerbot doctor' to debug."
  }
}

# --- 5. Done ---
Write-Host ''
Say "OK CareerBot installed"
Write-Host ''
Write-Host "  Start the dashboard:   " -NoNewline; Write-Host "careerbot" -ForegroundColor Cyan
Write-Host "  Then open:             http://localhost:3737"
Write-Host ''
if (-not $haveNode) {
  Hint "If 'careerbot' isn't found in a new PowerShell window, close and reopen it once to pick up the updated PATH."
}
