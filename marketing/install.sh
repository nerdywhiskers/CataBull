#!/usr/bin/env bash
#
# CareerBot installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://your-github-user.github.io/careerbot/install.sh | bash
#
# What it does:
#   1. Detect Node 18+. If missing, install fnm + Node 22 (no admin needed).
#   2. npm install -g github:your-github-user/careerbot
#   3. careerbot setup  (installs Playwright Chromium into user cache)
#
# Environment overrides:
#   CAREERBOT_REPO       — github:<owner>/<repo> source (default: your-github-user/careerbot)
#   CAREERBOT_NODE_MAJOR — Node major version to install if missing (default: 22)
#   CAREERBOT_SKIP_SETUP — set to 1 to skip the post-install `careerbot setup` step

set -euo pipefail

REPO="${CAREERBOT_REPO:-your-github-user/careerbot}"
MIN_NODE_MAJOR=18
NODE_MAJOR="${CAREERBOT_NODE_MAJOR:-22}"

# ANSI helpers — only if stdout is a TTY (skip during `| less`, etc.)
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '%s%s%s\n' "$BOLD" "$1" "$RESET"; }
hint() { printf '%s%s%s\n' "$DIM"  "$1" "$RESET"; }
warn() { printf '%s%s%s\n' "$YELLOW" "$1" "$RESET" >&2; }
fail() { printf '%s%s%s\n' "$RED"  "$1" "$RESET" >&2; exit 1; }

say "CareerBot installer"
hint "Source: github:$REPO"
echo

# --- Sanity checks ---
command -v curl >/dev/null 2>&1 || fail "curl is required but not found."
command -v bash >/dev/null 2>&1 || fail "bash is required."

# --- 1. Node detection ---
have_node=0
if command -v node >/dev/null 2>&1; then
  current_v="$(node -v 2>/dev/null || true)"
  current_major="$(printf '%s' "$current_v" | sed -E 's/^v([0-9]+).*/\1/' || true)"
  if [ -n "$current_major" ] && [ "$current_major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    say "✓ Node $current_v detected"
    have_node=1
  else
    hint "Node $current_v detected, but CareerBot needs >= v$MIN_NODE_MAJOR"
  fi
fi

# --- 2. Install Node via fnm if needed ---
if [ "$have_node" -eq 0 ]; then
  if ! command -v fnm >/dev/null 2>&1; then
    say "→ Installing fnm (Fast Node Manager — no admin required)"
    # fnm's installer puts a static binary in ~/.local/share/fnm and adds
    # init lines to the user's shell rc. We don't pass --skip-shell because
    # we *want* the user's future shells to find fnm + node automatically.
    curl -fsSL https://fnm.vercel.app/install | bash >/dev/null
  fi

  # Wire fnm into the current shell so the rest of this script can use it.
  # The installer puts fnm under one of these paths depending on platform.
  for candidate in \
    "$HOME/.local/share/fnm" \
    "$HOME/.fnm" \
    "/usr/local/bin"; do
    if [ -x "$candidate/fnm" ]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done

  command -v fnm >/dev/null 2>&1 || fail "fnm installed but not on PATH. Open a new terminal and re-run this script."

  say "→ Installing Node $NODE_MAJOR via fnm"
  fnm install "$NODE_MAJOR" >/dev/null
  fnm default "$NODE_MAJOR" >/dev/null
  # Eval fnm env into this shell — gives us `node` + `npm` on PATH.
  eval "$(fnm env --use-on-cd)"

  command -v node >/dev/null 2>&1 || fail "Node install succeeded but node is still not on PATH. Restart your terminal and retry."
  say "✓ Node $(node -v) ready"
fi

# --- 3. Install careerbot globally from GitHub ---
say "→ Installing careerbot from github:$REPO"
npm install -g "github:$REPO" >/dev/null
command -v careerbot >/dev/null 2>&1 || fail "careerbot installed but not on PATH. You may need to add the npm global bin to your PATH and re-open your terminal."
say "✓ careerbot $(careerbot --version 2>/dev/null || echo 'installed')"

# --- 4. Optional: install uv for JobSpy (Deep Scan Level 4) ---
# uv is Astral's single-binary Python manager. Same UX as fnm for Node:
# no admin, no system Python pollution. Skip if uv or python3 already exists.
if [ "${CAREERBOT_SKIP_JOBSPY:-0}" != "1" ]; then
  if ! command -v uv >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
    say "→ Installing uv (Python runner for JobSpy aggregator scans)"
    if curl -fsSL https://astral.sh/uv/install.sh | sh >/dev/null 2>&1; then
      export PATH="$HOME/.local/bin:$PATH"
      if command -v uv >/dev/null 2>&1; then
        say "✓ uv $(uv --version | awk '{print $2}') ready"
      else
        warn "uv install reported success but uv isn't on PATH. JobSpy Level 4 will be unavailable; re-run after opening a new terminal."
      fi
    else
      warn "uv install failed — skipping. JobSpy Level 4 will be unavailable until you install uv or python3."
    fi
  fi
fi

# --- 5. Run first-run setup (Playwright Chromium etc.) ---
if [ "${CAREERBOT_SKIP_SETUP:-0}" != "1" ]; then
  say "→ Running first-run setup (downloads Playwright Chromium on first install)"
  careerbot setup || warn "Setup reported issues — try 'careerbot doctor' to debug."
fi

# --- 5. Done ---
echo
say "✓ CareerBot installed"
echo
echo "  Start the dashboard:   ${BOLD}careerbot${RESET}"
echo "  Then open:             http://localhost:3737"
echo
if [ "$have_node" -eq 0 ]; then
  hint "If 'careerbot' isn't found in a fresh terminal, run:  exec \$SHELL -l"
fi
