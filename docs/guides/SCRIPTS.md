# Scripts Reference

Root `.mjs` files are compatibility wrappers. The implementations live in `scripts/` and tests live in `tests/`, but old commands such as `node scan.mjs` and `npm run scan` still work.

## Quick Reference

| Command | Script | Purpose |
|---------|--------|---------|
| `catabull` / `npm run dashboard` | `dashboard-web/server.mjs` | Launch the web dashboard (primary entry point) |
| `catabull doctor` / `npm run doctor` | `doctor.mjs` | Validate setup prerequisites |
| `catabull scan` / `npm run scan` | `scan.mjs` | Zero-token portal scanner |
| `catabull scan-health` / `npm run scan-health` | `scan-health.mjs` | Health-check tracked companies (W1) |
| `catabull verify` / `npm run verify` | `verify-pipeline.mjs` | Check pipeline data integrity |
| `npm run normalize` | `normalize-statuses.mjs` | Fix non-canonical statuses |
| `npm run dedup` | `dedup-tracker.mjs` | Remove duplicate tracker entries |
| `npm run merge` | `merge-tracker.mjs` | Merge batch TSVs into applications.md |
| `npm run pdf` | `generate-pdf.mjs` | Convert HTML to ATS-optimized PDF |
| `npm run sync-check` | `cv-sync-check.mjs` | Validate CV/profile consistency |
| `npm run liveness` | `check-liveness.mjs` | Test if job URLs are still active |
| `npm test` | `tests/test-all.mjs` | Run the integration smoke test suite |
| `npm run test:unit` | selected `tests/test-*.mjs` suites from `package.json` | Run the unit suite set wired into npm |

---

## doctor

Validates that all prerequisites are in place: Node.js >= 18, dependencies installed, Playwright chromium, required files (`cv.md`, `config/profile.yml`, `portals.yml`), fonts directory, and auto-creates `data/`, `output/`, `reports/` if missing.

```bash
npm run doctor
```

**Exit codes:** `0` all checks passed, `1` one or more checks failed (fix messages printed).

---

## verify

Health check for pipeline data integrity. Validates `data/applications.md` against seven rules: canonical statuses (per `templates/states.yml`), no duplicate company+role pairs, all report links point to existing files, scores match `X.XX/5` / `N/A` / `DUP`, rows have proper pipe-delimited format, no pending TSVs in `batch/tracker-additions/`, and no markdown bold in scores.

```bash
npm run verify
```

**Exit codes:** `0` pipeline clean (zero errors), `1` errors found. Warnings (e.g. possible duplicates) do not cause a non-zero exit.

---

## normalize

Maps non-canonical statuses to their canonical equivalents and strips markdown bold and dates from the status column. Aliases like `Enviada` become `Aplicado`, `CERRADA` becomes `Descartado`, etc. DUPLICADO info is moved to the notes column.

```bash
npm run normalize             # apply changes
npm run normalize -- --dry-run  # preview without writing
```

Creates a `.bak` backup of `applications.md` before writing.

**Exit codes:** `0` always (changes or no changes).

---

## dedup

Removes duplicate entries from `applications.md` by grouping on normalized company name + fuzzy role match. Keeps the entry with the highest score. If a removed entry had a more advanced pipeline status, that status is promoted to the keeper.

```bash
npm run dedup             # apply changes
npm run dedup -- --dry-run  # preview without writing
```

Creates a `.bak` backup before writing.

**Exit codes:** `0` always.

---

## merge

Merges batch tracker additions (`batch/tracker-additions/*.tsv`) into `applications.md`. Handles 9-column TSV, 8-column TSV, and pipe-delimited markdown formats. Detects duplicates by report number, entry number, and company+role fuzzy match. Higher-scored re-evaluations update existing entries in place.

```bash
npm run merge                 # apply merge
npm run merge -- --dry-run    # preview without writing
npm run merge -- --verify     # merge then run verify-pipeline
```

Processed TSVs are moved to `batch/tracker-additions/merged/`.

**Exit codes:** `0` success, `1` verification errors (with `--verify`).

---

## pdf

Renders an HTML file to a print-quality, ATS-parseable PDF via headless Chromium. Resolves font paths from `fonts/`, normalizes Unicode for ATS compatibility (em-dashes, smart quotes, zero-width characters), and reports page count and file size.

```bash
npm run pdf -- input.html output.pdf
npm run pdf -- input.html output.pdf --format=letter   # US letter
npm run pdf -- input.html output.pdf --format=a4        # A4 (default)
```

**Exit codes:** `0` PDF generated, `1` missing arguments or generation failure.

---

## sync-check

Validates that the CataBull setup is internally consistent: `cv.md` exists and is not too short, `config/profile.yml` exists with required fields, no hardcoded metrics in `modes/_shared.md` or `batch/batch-prompt.md`, and `article-digest.md` freshness (warns if older than 30 days).

```bash
npm run sync-check
```

**Exit codes:** `0` no errors (warnings allowed), `1` errors found.

---

## liveness

Tests whether job posting URLs are still live using headless Chromium. Detects expired patterns (e.g. "job no longer available"), HTTP 404/410, ATS redirect patterns, and apply-button presence. Supports multi-language expired patterns (English, German, French).

```bash
npm run liveness -- https://example.com/job/123
npm run liveness -- https://a.com/job/1 https://b.com/job/2
npm run liveness -- --file urls.txt
```

Each URL gets a verdict: `active`, `expired`, or `uncertain` with a reason.

**Exit codes:** `0` all URLs active, `1` any expired or uncertain.

---

## scan

Zero-token portal scanner. Hits ATS APIs (Greenhouse, Ashby, Lever, Workday, BambooHR, Teamtailor) and career pages directly — no LLM tokens consumed. Reads `portals.yml` for target companies and search queries, outputs matching listings to stdout and optionally appends to `data/pipeline.md`. Includes the W5 outbound-link sniffer for branded careers pages with hidden ATS hosts.

```bash
npm run scan
```

**Exit codes:** `0` scan completed, `1` configuration error or no portals.yml found.

---

## scan-health

Per-company health classifier (W1). Runs against every entry in `portals.yml > tracked_companies` and tags each with one of eight statuses (`healthy`, `empty`, `not_found`, `redirected`, `bot_blocked`, `unknown_ats`, `network_error`, `no_provider`). Writes `data/scan-health.json` snapshot + `data/scan-health.log` audit trail. After three consecutive failures, auto-disables the company (W4 decay tracking).

```bash
npm run scan-health
```

**Exit codes:** `0` snapshot written, `1` configuration error.

---

## Scripts without npm wrappers

These are invoked directly by modes or the dashboard, not as top-level commands:

- `analyze-patterns.mjs` — rejection pattern analysis (JSON output), used by `/catabull patterns`
- `followup-cadence.mjs` — follow-up timing calculator (JSON output), used by `/catabull followup`
- `bin/catabull.mjs` — global CLI entry shim (used by `npm install -g github:your-github-user/catabull`)

## Test scripts

Unit and smoke suites live in `tests/`; each is exit-coded for CI. `npm run test:unit` runs the subset wired in `package.json`, and `npm test` (`tests/test-all.mjs`) runs the integration smoke suite.

| Area | Representative files |
|---|---|
| Core data + tracker behavior | `test-core.mjs`, `test-health.mjs`, `test-providers.mjs`, `test-relevance.mjs`, `test-score-blocks.mjs` |
| Workspace, setup, profiles, settings | `test-workspace.mjs`, `test-resolver.mjs`, `test-profiles.mjs`, `test-settings.mjs`, `test-updates.mjs` |
| Dashboard and user flows | `test-discover.mjs`, `test-chat-session.mjs`, `test-tailor.mjs`, `test-cv.mjs`, `test-recovery.mjs`, `test-frontend-smoke.mjs` |
| Discovery/search extensions | `test-discovery.mjs`, `test-onboarding.mjs`, `test-websearch.mjs`, `test-level3.mjs`, `test-jobspy.mjs`, `test-sniff.mjs` |
| Security regressions | `test-security-regression.mjs` |

Check `package.json` for the exact suites currently included in `npm run test:unit`.
