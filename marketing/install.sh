#!/usr/bin/env bash
#
# CataBull installer for macOS and Linux.
#
# Usage:
#   curl -fsSL https://nerdywhiskers.github.io/CataBull/install.sh | bash
#
# What it does:
#   1. Detect Node 18+. If missing, install fnm + Node 22 (no admin needed).
#   2. Resolve the latest deployed GitHub Release tag (fallback: main).
#   3. npm install -g github:nerdywhiskers/CataBull#<release-tag-or-main>
#   4. catabull setup  (installs Playwright Chromium into user cache)
#
# Environment overrides:
#   CATABULL_REPO       — github:<owner>/<repo> source (default: nerdywhiskers/CataBull)
#   CATABULL_REF        — explicit git ref/tag to install (skips GitHub release lookup)
#   CATABULL_NODE_MAJOR — Node major version to install if missing (default: 22)
#   CATABULL_SKIP_SETUP — set to 1 to skip the post-install `catabull setup` step

set -euo pipefail

REPO="${CATABULL_REPO:-nerdywhiskers/CataBull}"
REF="${CATABULL_REF:-}"
MIN_NODE_MAJOR=18
NODE_MAJOR="${CATABULL_NODE_MAJOR:-22}"

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

say "CataBull installer"
hint "Source: github:$REPO"
echo

# --- Sanity checks ---
command -v curl >/dev/null 2>&1 || fail "curl is required but not found."
command -v bash >/dev/null 2>&1 || fail "bash is required."

resolve_release_ref() {
  [ -n "$REF" ] && return 0
  say "→ Resolving latest deployed release"
  local api="https://api.github.com/repos/$REPO/releases/latest"
  local json
  if ! json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null)"; then
    REF="main"
    warn "No published GitHub Release found for $REPO yet — falling back to main"
    return 0
  fi
  REF="$(printf '%s' "$json" | tr -d '\n' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [ -n "$REF" ] && [ "$REF" != "$json" ] || fail "Could not parse latest release tag for $REPO"
}

resolve_release_ref
hint "Release ref: $REF"

# --- 1. Node detection ---
have_node=0
if command -v node >/dev/null 2>&1; then
  current_v="$(node -v 2>/dev/null || true)"
  current_major="$(printf '%s' "$current_v" | sed -E 's/^v([0-9]+).*/\1/' || true)"
  if [ -n "$current_major" ] && [ "$current_major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    say "✓ Node $current_v detected"
    have_node=1
  else
    hint "Node $current_v detected, but CataBull needs >= v$MIN_NODE_MAJOR"
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

# --- 3. Install catabull globally from GitHub ---
say "→ Installing catabull from github:$REPO#$REF"
npm install -g "github:$REPO#$REF" >/dev/null
command -v catabull >/dev/null 2>&1 || fail "catabull installed but not on PATH. You may need to add the npm global bin to your PATH and re-open your terminal."
say "✓ catabull $(catabull --version 2>/dev/null || echo 'installed')"

# --- 4. Optional: install uv for JobSpy (Deep Scan Level 4) ---
# uv is Astral's single-binary Python manager. Same UX as fnm for Node:
# no admin, no system Python pollution. Skip if uv or python3 already exists.
if [ "${CATABULL_SKIP_JOBSPY:-0}" != "1" ]; then
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
if [ "${CATABULL_SKIP_SETUP:-0}" != "1" ]; then
  say "→ Running first-run setup (downloads Playwright Chromium on first install)"
  catabull setup || warn "Setup reported issues — try 'catabull doctor' to debug."
fi

# --- 5. Done ---
echo
say "✓ CataBull installed"
echo
echo "  Start the dashboard:   ${BOLD}catabull${RESET}"
echo "  Then open:             http://localhost:3737"
echo
if [ "$have_node" -eq 0 ]; then
  hint "If 'catabull' isn't found in a fresh terminal, run:  exec \$SHELL -l"
fi
