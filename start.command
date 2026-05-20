#!/bin/bash
# Double-click to launch CareerBot dashboard on macOS.
#
# Two macOS gotchas this script defends against:
#   1. Gatekeeper attaches `com.apple.quarantine` to every file in a downloaded
#      zip/dmg. That xattr makes Finder block .command files and later makes
#      Playwright's downloaded Chromium binary refuse to run.
#   2. Finder launches scripts with a minimal PATH (/usr/bin:/bin) — Homebrew
#      paths aren't included, so `command -v node` fails on Apple Silicon Macs
#      even when node is installed.

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Strip quarantine xattr from the project so Gatekeeper doesn't block child
# processes. -r recurses into the Playwright cache and node_modules. Silent
# failure is fine — the xattr may simply not be present.
xattr -dr com.apple.quarantine . 2>/dev/null || true

# Finder launches with a minimal PATH; prepend Homebrew locations so node
# resolves on both Apple Silicon (/opt/homebrew) and Intel (/usr/local).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"

if ! command -v node &>/dev/null; then
    echo ""
    echo "  Node.js is required but not found on PATH."
    echo ""
    echo "  Install one of these, then double-click start.command again:"
    echo "    Homebrew (recommended): brew install node"
    echo "    Direct download:        https://nodejs.org"
    echo ""
    echo "  If node IS installed, your shell may have a custom PATH that"
    echo "  Finder doesn't see. Open this file in a text editor and add"
    echo "  your node directory to the export PATH line."
    echo ""
    read -p "  Press Enter to exit..."
    exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo ""
    echo "  Node.js 18+ required (you have $(node --version))."
    echo "  Upgrade: brew upgrade node    (or download from https://nodejs.org)"
    echo ""
    read -p "  Press Enter to exit..."
    exit 1
fi

node start.mjs
