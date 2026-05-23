#!/bin/bash
# Mac-specific diagnostics for CataBull. Catches the macOS-only issues
# (quarantine xattrs, Finder PATH, TCC-restricted folders) that the
# cross-platform doctor.mjs can't see, then runs doctor.mjs for the rest.

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
DIM='\033[2m'
RESET='\033[0m'

ok()    { printf "${GREEN}✓${RESET} %s\n" "$1"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$1"; FAILURES=$((FAILURES+1)); }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$1"; WARNINGS=$((WARNINGS+1)); }
hint()  { printf "  ${DIM}→ %s${RESET}\n" "$1"; }

FAILURES=0
WARNINGS=0

echo
echo "CataBull doctor — macOS"
echo "========================"
echo
echo "macOS:    $(sw_vers -productVersion 2>/dev/null || echo "unknown")"
echo "Arch:     $(uname -m)"
echo "Project:  $PROJECT_DIR"
echo

# --- Quarantine xattr ---
QUARANTINED=$(xattr -lr "$PROJECT_DIR" 2>/dev/null | grep -c 'com.apple.quarantine' || true)
if [ "$QUARANTINED" -eq 0 ]; then
    ok "No quarantine xattrs in project"
else
    fail "$QUARANTINED file(s) have com.apple.quarantine xattr"
    hint "Strip it: xattr -dr com.apple.quarantine \"$PROJECT_DIR\""
fi

# --- TCC-restricted location ---
case "$PROJECT_DIR" in
    "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*)
        warn "Project is in a TCC-protected folder ($PROJECT_DIR)"
        hint "macOS may block file access by Terminal/iTerm here."
        hint "Either grant Terminal Full Disk Access (System Settings →"
        hint "Privacy & Security → Full Disk Access), or move the project"
        hint "somewhere else: mv \"$PROJECT_DIR\" ~/CataBull"
        ;;
    *)
        ok "Project is outside TCC-protected folders"
        ;;
esac

# --- node visible to Finder PATH ---
# When .command files are double-clicked, Finder uses a minimal PATH that
# excludes Homebrew. Detect that case so we can warn before the user is
# confused by "node not found" on next launch.
FINDER_PATH="/usr/bin:/bin:/usr/sbin:/sbin"
if PATH="$FINDER_PATH" command -v node >/dev/null 2>&1; then
    ok "node visible to Finder-launched scripts"
else
    if command -v node >/dev/null 2>&1; then
        NODE_PATH=$(dirname "$(command -v node)")
        warn "node ($NODE_PATH) not on the minimal PATH Finder uses"
        hint "start.command already prepends Homebrew paths, so this is fine"
        hint "as long as node lives in /opt/homebrew/bin or /usr/local/bin."
        case "$NODE_PATH" in
            /opt/homebrew/bin|/usr/local/bin) ;;
            *) hint "Your node is in $NODE_PATH — edit start.command to add it" ;;
        esac
    else
        fail "node not found on PATH at all"
        hint "Install: brew install node    (or https://nodejs.org)"
    fi
fi

# --- Playwright Chromium quarantine ---
PW_CACHE="$HOME/Library/Caches/ms-playwright"
if [ -d "$PW_CACHE" ]; then
    PW_QUARANTINED=$(xattr -lr "$PW_CACHE" 2>/dev/null | grep -c 'com.apple.quarantine' || true)
    if [ "$PW_QUARANTINED" -eq 0 ]; then
        ok "Playwright cache: no quarantine xattrs"
    else
        fail "Playwright Chromium has $PW_QUARANTINED quarantine xattr(s)"
        hint "PDF generation and scans will fail. Strip them:"
        hint "  xattr -dr com.apple.quarantine \"$PW_CACHE\""
    fi
else
    warn "Playwright cache not yet created ($PW_CACHE)"
    hint "Will be populated on first run of start.command"
fi

# --- start.command executable bit ---
if [ -x "$PROJECT_DIR/start.command" ]; then
    ok "start.command is executable"
else
    fail "start.command is not executable"
    hint "Fix: chmod +x \"$PROJECT_DIR/start.command\""
fi

# --- CataBull.app launcher executable bit ---
APP_LAUNCHER="$PROJECT_DIR/CataBull.app/Contents/MacOS/catabull"
if [ -f "$APP_LAUNCHER" ]; then
    if [ -x "$APP_LAUNCHER" ]; then
        ok "CataBull.app launcher is executable"
    else
        fail "CataBull.app launcher is not executable (app won't open)"
        hint "Fix: chmod +x \"$APP_LAUNCHER\""
    fi
fi

echo
echo "Cross-platform checks (doctor.mjs)"
echo "----------------------------------"

# Run the existing cross-platform doctor. Re-export the same PATH adjustments
# start.command uses so node resolves even under Finder-minimal PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v node >/dev/null 2>&1; then
    node doctor.mjs
    DOCTOR_EXIT=$?
else
    fail "Skipping doctor.mjs — node not available"
    DOCTOR_EXIT=1
fi

echo
if [ "$FAILURES" -gt 0 ] || [ "$DOCTOR_EXIT" -ne 0 ]; then
    echo "Result: macOS issues need fixing — apply the suggested commands above."
    read -p "Press Enter to close..."
    exit 1
elif [ "$WARNINGS" -gt 0 ]; then
    echo "Result: $WARNINGS warning(s), no blockers."
    read -p "Press Enter to close..."
    exit 0
else
    echo "Result: All macOS checks passed."
    read -p "Press Enter to close..."
    exit 0
fi
