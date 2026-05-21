#!/usr/bin/env bash
# Pre-release secret scan: full git history (all refs) + working tree.
# Prints findings for human review. Always exits 0 — judgement is yours.
# Prefer gitleaks/trufflehog when available; this is the zero-dependency fallback.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || { echo "not a git repo"; exit 1; }

HIGH='(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{59,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|sk_live_[A-Za-z0-9]{20,}|rk_live_[A-Za-z0-9]{20,}|SG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|hooks\.slack\.com/services/[A-Za-z0-9/]+|discord(app)?\.com/api/webhooks/[0-9]+/'
MOD='(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|bearer)["'"'"' ]*[:=]["'"'"' ]*[A-Za-z0-9/_+.-]{8,}'
URLCRED='[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]+@'
EXCL='example|placeholder|your[-_]|changeme|xxxx|<[a-z]|dummy|sample|redacted|fake|process\.env|env\[|getenv|\$\{|user:pass'

echo "=== 1) HIGH-CONFIDENCE secrets across ALL history ==="
git log --all -p --no-color 2>/dev/null | grep -nEi "$HIGH" | head -40 || true
echo "  (empty above = no high-confidence hits)"
echo
echo "=== 2) Sensitive filenames EVER added ==="
git log --all --diff-filter=A --name-only --pretty=format: 2>/dev/null \
 | grep -Ei '(^|/)(\.env(\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.pfx|.*\.p12|.*\.key|.*\.keystore|credentials(\.json|\.ya?ml)?|secrets?\.(json|ya?ml|env)|\.npmrc|\.pypirc|\.netrc)$' \
 | sort -u || true
echo "  (empty above = no sensitive filenames committed)"
echo
echo "=== 3) Credential-bearing URLs (user:pass@host), working tree ==="
git grep -nEi "$URLCRED" -- ':!*.lock' 2>/dev/null | grep -vEi "$EXCL" | head -20 || true
echo "  (empty above = clean)"
echo
echo "=== 4) MODERATE quoted-secret assignments, working tree (minus placeholders) ==="
git grep -nEi "$MOD" -- ':!*.lock' ':!*.svg' 2>/dev/null | grep -vEi "$EXCL" | head -40 || true
echo "  (review these by hand — most are usually env reads / test dummies)"
echo
echo "=== 5) MODERATE patterns added in history (minus placeholders) ==="
git log --all -p --no-color 2>/dev/null \
 | grep -nEi "^\+.*($URLCRED|(secret|password|api[_-]?key|token)[\"' ]*[:=][\"' ]*[A-Za-z0-9/_+.-]{16,})" \
 | grep -vEi "$EXCL" | head -30 || true
echo "  (empty above = clean)"
echo
echo "Done. A real token, private key, or user:pass@host URL means: rotate it,"
echo "scrub history (git filter-repo), and re-scan before going public."
