# Development workflow

How to keep day-to-day work landing in `dev`, keep `main` clean, and promote tested changes when ready.

## Goal

- Feature, fix, and docs PRs land in `dev`
- `main` stays release-grade
- Promotion to `main` happens only from `dev`
- Agent-backed editing behavior stays predictable across supported CLIs

## Branch roles

### `dev`

Active integration branch.

Use `dev` for:
- feature PRs
- bugfix PRs
- docs PRs
- agent integration changes
- validation before release

### `main`

Stable release branch.

Use `main` for:
- tagged releases
- the public default install path
- the branch that should stay safest for end users

## CLI behavior contract

CataBull should standardize on a product-level contract, not identical flags on every agent CLI.

Target contract:
- workspace is writable
- agent asks when needed
- no silent fallback to read-only when Catabull expects edits
- no global YOLO / bypass mode unless explicitly intended

Why this is not one literal command for every CLI:
- Codex uses sandbox + approval flags
- Claude uses permission modes
- Gemini uses sandbox + approval mode + yolo
- Hermes has normal approval behavior vs `--yolo`
- OpenClaw routes through Gateway semantics, which is a different control layer
- OpenCode may expose different controls depending on installed version

So consistency means:
- same user expectation
- same Catabull safety posture
- same write-vs-approval contract

It does **not** mean every CLI gets the exact same argv.

## Current recommended mapping

### Codex

Use explicit flags in both one-shot and PTY paths:

```bash
--sandbox workspace-write --ask-for-approval on-request
```

### Claude

Prefer a normal ask-when-needed permission mode for routine dashboard use.

Avoid treating `acceptEdits` as equivalent to on-request. It is closer to auto-approving edits.

### Gemini

Prefer sandboxed, approval-gated editing behavior.

Avoid `--yolo` for normal dashboard editing flows.

### Hermes

Prefer normal approval behavior for dashboard sessions.

Avoid forcing `--yolo` unless the workflow explicitly wants bypassed approvals.

### OpenCode

Inspect the installed CLI help and map to the same contract. Do not guess flags.

### OpenClaw

Treat this separately. Gateway-driven sessions are not the same as a local sandboxed CLI process, so policy may need to live in OpenClaw config rather than Catabull argv.

## The safest repo workflow

### Rule 1: make `dev` the default PR target

Set the repo default branch to `dev`.

Why:
- GitHub PR UI defaults new PRs to the default branch
- most accidental `main` PRs disappear if `dev` is the default base
- feature work naturally stacks into the integration branch

## How to make sure normal PRs do not merge to `main`

Use all three layers.

### Layer 1: default branch = `dev`

Repo settings:
- set default branch to `dev`

This handles the common case.

### Layer 2: protect `main`

Add a branch protection rule or ruleset for `main`:
- require a pull request before merging
- require status checks to pass
- require approvals if desired
- block direct pushes
- optionally restrict who can merge

This keeps `main` harder to touch.

### Layer 3: fail any PR to `main` unless head branch is `dev`

This is the hard guard.

Add a required GitHub Actions check that fails if a PR targets `main` from anything other than `dev`.

Example workflow:

```yaml
name: enforce-main-from-dev

on:
  pull_request:
    branches: [main]

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - name: Fail unless PR comes from dev
        run: |
          echo "Base branch: ${{ github.base_ref }}"
          echo "Head branch: ${{ github.head_ref }}"
          if [ "${{ github.head_ref }}" != "dev" ]; then
            echo "Only dev -> main PRs are allowed."
            exit 1
          fi
```

Then make that check required on `main`.

Result:
- `feature/foo -> main` fails
- `fix/bar -> main` fails
- `docs/baz -> main` fails
- `dev -> main` passes this guard and can continue through normal checks

This is strongest practical enforcement if the team wants `main` to act like a release branch.

## Day-to-day flow

### Start feature work

```bash
git fetch origin --prune
git checkout dev
git pull --ff-only origin dev
git checkout -b feat/my-change
```

### Open PR

Open PRs with base `dev`:

```bash
gh pr create --base dev --head feat/my-change
```

### Merge feature PR

Merge into `dev` after review and green checks.

## How to promote `dev` to `main`

When `dev` looks good:

### Step 1: sync local branches

```bash
git fetch origin --prune
git checkout dev
git pull --ff-only origin dev
git checkout main
git pull --ff-only origin main
```

### Step 2: open a release PR from `dev` to `main`

```bash
gh pr create --base main --head dev \
  --title "release: promote dev to main" \
  --body "## Summary
- promote tested changes from dev to main

## Verification
- all required checks passed on dev
- release validation complete"
```

### Step 3: review and run release checks

Before merging the release PR, verify:
- CI is green
- smoke tests pass
- docs are in acceptable shape
- nothing experimental is still hiding in `dev`

### Step 4: merge the release PR

Preferred:
- merge `dev` into `main` with a normal merge commit so release boundaries stay visible

Example:

```bash
gh pr merge --merge
```

Using a merge commit here is usually cleaner than squashing because `dev` is an integration branch, not a one-feature branch.

### Step 5: tag if you want a release marker

```bash
git checkout main
git pull --ff-only origin main
git tag v1.5.0
git push origin v1.5.0
```

## After `dev` -> `main`

Usually nothing special is needed because `main` now contains `dev` at the merge point.

Good cleanup steps:
- keep future PRs targeting `dev`
- continue new work from updated `dev`
- only open `dev -> main` PRs when a release is ready

## Recommended policy summary

If you want the simplest strong workflow:

1. set default branch to `dev`
2. protect `main`
3. require a guard check on `main` PRs that only allows `dev` as the head branch
4. merge normal work into `dev`
5. promote with explicit `dev -> main` release PRs

That gives:
- fast day-to-day iteration in `dev`
- stable `main`
- clear release moments
- fewer accidental direct merges into production-facing history
