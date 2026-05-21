---
name: prerelease-hardening
description: Security-harden a GitHub repository before making it public (or any pre-release lockdown). Scans the full git history for committed secrets, then applies the protections the current plan/visibility allows (CODEOWNERS, branch ruleset, Dependabot, read-only Actions token, secret scanning) and version-controls anything gated behind a paid/public plan as config plus a go-public checklist. Use when asked to "harden the repo", "lock it down", "prep for release / open-sourcing", "make the repo public safely", or "check for leaked secrets".
---

# Pre-release security hardening

Run this before flipping a private repo to public — or any time you want a
repo locked down. The goal: never publish a leaked secret, and make sure
outside contributors can read but not change protected branches without
review.

Key reality this skill is built around: **several GitHub protections are
gated on a paid plan or public visibility.** On a private Free repo,
branch rulesets and secret scanning are blocked. So the strategy is:
**apply everything that works now, and version-control the rest so it's one
command (or one UI import) on launch day.** Never silently skip a blocked
control — report it and stage it.

## Step 0 — Recon (always first)

```bash
gh auth status
gh repo view --json nameWithOwner,visibility,isPrivate,defaultBranchRef,viewerPermission
gh api repos/{owner}/{repo}/collaborators \
  --jq '.[] | {login, role: .role_name, admin: .permissions.admin}'
command -v gitleaks trufflehog   # use them if present; otherwise this skill's scan
```

Note the repo `nameWithOwner` and `isPrivate` — every later command uses
them, and visibility decides what will succeed. Confirm `viewerPermission`
is `ADMIN` (settings changes need it). Flag any unexpected collaborator.

## Step 1 — Secret scan (plan-independent, do this regardless)

Prefer `gitleaks detect --no-banner` or `trufflehog git file://. --only-verified`
if installed. Otherwise run the bundled scan, which covers the full history
across all refs plus the working tree:

```bash
bash "$CLAUDE_SKILL_DIR/secret-scan.sh"   # or paste the patterns from it
```

(If bash is unavailable, the script's regexes can be run through ripgrep or
PowerShell — the patterns are the asset, the shell is incidental.)

Review every hit by hand. Expect benign noise: `env.X_API_KEY` reads, code
identifiers like `const token = ...`, test dummies, and commented-out
example values. A real hit (a live token, private key, or `user:pass@host`
URL) means **stop** — the secret must be rotated and scrubbed from history
(`git filter-repo`) before going public, because history is exposed too.

## Step 2 — Apply protections that work now

**CODEOWNERS** — commit `.github/CODEOWNERS` on every branch you'll protect
(GitHub reads it from the PR's base branch):

```
* @<owner>
```

**Repo settings that work even on private Free:**

```bash
# Dependabot
gh api --silent -X PUT repos/{owner}/{repo}/vulnerability-alerts
gh api --silent -X PUT repos/{owner}/{repo}/automated-security-fixes
# Default GITHUB_TOKEN read-only; Actions can't approve PRs
gh api --silent -X PUT repos/{owner}/{repo}/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
```

(Read-only default is safe: well-formed workflows declare the scopes they
need in their own `permissions:` block, which overrides the default.)

**Branch ruleset** — apply with the bundled template. The repo admin is a
bypass actor, so the owner keeps frictionless direct pushes while everyone
else is gated (PR + code-owner review, no force-push, no deletion):

```bash
gh api -X POST repos/{owner}/{repo}/rulesets \
  --input "$CLAUDE_SKILL_DIR/ruleset.template.json"
```

Edit `conditions.ref_name.include` to list the branches to protect. If the
POST returns **403 "Upgrade to GitHub Pro or make this repository public"**,
it's gated — go to Step 3. To make rules bind the owner too, drop
`bypass_actors` (then even the owner must open PRs).

**Secret scanning + push protection:**

```bash
gh api -X PATCH repos/{owner}/{repo} \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

A **422 "Secret scanning is not available for this repository"** means it's
gated (private without Advanced Security) — go to Step 3. It's free once
public.

## Step 3 — Version-control whatever was gated

For each blocked control, don't drop it — make it one step on launch day:

1. Save the ruleset payload to `.github/rulesets/<name>.json` (committed).
2. Write `docs/deploy/going-public.md` (or `SECURITY-CHECKLIST.md`) listing,
   in order: flip visibility → apply ruleset (the exact `gh api` command) →
   enable secret scanning → require approval for fork-PR workflows
   (Settings → Actions → General, UI) → lock any deployment environment to
   its branch (Settings → Environments, after first deploy) → optional:
   disable Issues/Wiki/Discussions, custom domain.
3. Note which items are already active vs. deferred, so nothing is forgotten.

## Step 4 — Report

Give the user a clear table: each control, and whether it's **active now**,
**gated → staged for go-public**, or **needs a manual UI step**. Restate any
real secret-scan finding loudly. Confirm the collaborator audit result.

## Reference — what's gated where

| Control | Private + Free | Public (any plan) |
| --- | --- | --- |
| Secret scan (this skill) | ✅ works | ✅ works |
| CODEOWNERS file | ✅ | ✅ |
| Dependabot alerts / fixes | ✅ | ✅ |
| Read-only default `GITHUB_TOKEN` | ✅ | ✅ |
| Branch ruleset / branch protection | ❌ Pro/Team+ | ✅ |
| Secret scanning + push protection | ❌ Adv. Security | ✅ free |
| Fork-PR workflow approval | n/a (no outside forks) | ✅ (UI) |
| Environment deploy-branch lock | ❌ Pro+ (private) | ✅ (UI) |

Forking can't be disabled on a personal-account public repo — only for
org-owned repos. Mention moving to a (free) org if fork control matters.
