# Mode: healthcheck

Repeatable portal healthcheck and auto-recovery for tracked companies in `portals.yml`. Re-probe everything, classify failures, attempt fixes, propose changes, apply on confirmation.

## When to run

- After bulk-importing companies (many will be misconfigured)
- Periodically (monthly) — companies migrate ATSes, slugs change, boards go dark
- When `data/scan-health.json` shows growing `unknown_ats` / `not_found` counts
- When the user explicitly asks: "healthcheck the portals", "fix the broken companies", "which scans are failing"

## Workflow

This mode is driven by `scripts/healthcheck.mjs`. Don't reimplement the logic in the prompt — call the script.

### Step 1 — Baseline

```
node scripts/healthcheck.mjs baseline
```

Re-runs `scan-health.mjs --all` against every company in `portals.yml` (including `enabled: false`). Writes `data/scan-health.json`. Wall time: 15-30 min for ~500 companies.

If a recent baseline already exists (check `finishedAt` in the JSON — within last 24h is fine), skip this step.

### Step 2 — Recover

```
node scripts/healthcheck.mjs recover
```

Reads the baseline, attempts auto-recovery for each broken company, writes proposals to `data/healthcheck-proposals.json`.

- **Phase 1 (fast, HTTP-only):** slug-variant probing against Greenhouse/Ashby/Lever JSON APIs. Tries `<normalized-name>`, `<name>careers`, `<name>-careers`, and the slug already in the URL. First variant that returns a JSON board with ≥1 job wins. Deliberately does NOT try first-word-only variants — that produced false positives like "Blue Origin → lever/blue" matching an unrelated Eastern Europe data company.
- **Phase 2 (slower, Playwright):** for companies that survive Phase 1, navigates the careers page in a headless browser, captures every network request + iframe src, and matches against ATS hostname patterns (Greenhouse, Ashby, Lever, Workday `myworkdayjobs.com`, SmartRecruiters, Workable, Teamtailor, BambooHR). The killer signal is that even when a marketing page renders no `<a>` to an ATS, it's usually still making XHR calls to one. Each candidate is verified against the public API before being accepted.

Use `--phase 1` for fast iteration, `--phase 2` for Playwright-only, or omit for both (default).

### Step 2b — Phase 3 (JobSpy fallback, opt-in)

```
node scripts/healthcheck.mjs jobspy              # probe all still-broken companies
node scripts/healthcheck.mjs jobspy "Epic Games" # probe one company
node scripts/healthcheck.mjs jobspy --linkedin   # add LinkedIn (rate-limit heavy)
```

For companies whose careers page is fully custom (Epic, Riot, Roblox, Meta, etc.) and has no public ATS endpoint, Phase 3 queries JobSpy (Indeed by default, LinkedIn opt-in). For each company that returns ≥1 hit whose `company` field matches the tracked name, the proposal patches `scan_method: jobspy` so the scanner will route that company through the JobSpy provider on the next sweep.

**Caveats:**

- Reality is brutal: most companies with custom in-house boards don't post to Indeed either, so Phase 3 commonly returns 0 hits for the companies it most needs to help with.
- JobSpy rate-limits aggressively. Sites that block the request return 0 hits silently — there's no clean way to tell "no jobs at this company" apart from "we got blocked." Treat Phase 3 results as a positive signal only.
- LinkedIn requires the optional `--linkedin` flag because it block-lists IPs within a few dozen queries. Don't sweep all stragglers via LinkedIn in one go.
- Phase 3 runs sequentially (not parallel) to be polite to the boards. Expect ~2-5s per company.
- The venv at `tools/audit/.venv/` must exist with `python-jobspy` installed. See `tools/audit/README.md` for setup.

### Step 3 — Review + apply

```
node scripts/healthcheck.mjs apply --dry-run
node scripts/healthcheck.mjs apply
```

`--dry-run` shows the proposed before/after for each entry. Drop the flag to write changes to `portals.yml`.

**Always dry-run first** and show the diff to the user before applying. Recovery proposals are heuristic — a slug match with ≥1 job means the board exists at that location, but it may not be the *right* company (e.g. a company named "Pixel" might match a different "pixel" board).

### Step 4 — Report

```
node scripts/healthcheck.mjs report
```

Writes `data/healthcheck-{YYYY-MM-DD}.md` summarizing the run: summary table, recovered companies, still-broken list. Commit this alongside the `portals.yml` changes.

## What to tell the user

Lead with the headline number: "X of 508 broken, recovered Y in Phase 1, Z need a manual look." Then show the list of recoveries with old → new URL diffs. Don't dump the full proposals JSON — summarize.

## Things to watch

- **False positives:** if a company name is a common word ("box", "fly", "lemon"), Phase 1 will probably find a board at that slug — but it may belong to a different "box". Cross-check the company name against the board's job titles before applying.
- **Newly-enabled-by-fix:** when a previously `not_found` company gets a working URL, it's still `enabled: false` if that's what it was before. Don't auto-enable — let the user decide.
- **Phenom People / in-house boards:** Phase 2 doesn't yet match Phenom (Adobe), workday-cloud-storefront variants, or fully custom in-house career sites (Epic, Riot, Roblox). Those land in the still-broken section of the report and need Phase 3.
- **Profile switches mid-flow:** `portals.yml` is per-profile user data; `scan-health.json` is not. If the active profile changes between `baseline` and `apply`, the proposals will target a portals.yml whose company list may differ. The script stamps `profile` into `healthcheck-proposals.json` and refuses to apply against a different active profile (override with `--force`).
