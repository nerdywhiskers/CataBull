# Market Discovery — Design Spec (W6)

> **Status: shipped Phase 1 (2026-05-15).** Adapted for the post-PR
> Level 3 architecture — JobSpy results flow through the same dedupe +
> liveness + pipeline.md pipeline as Level 3, not a separate
> `data/market.md` triage file.
>
> Code lives at:
> - [`scan/market/jobspy_wrapper.py`](../../scan/market/jobspy_wrapper.py) — Python sidecar
> - [`scan/market/jobspy.mjs`](../../scan/market/jobspy.mjs) — Node adapter
> - `runLevel4()` in [`dashboard-web/routes/scan-deep.mjs`](../../dashboard-web/routes/scan-deep.mjs)
> - Tests: [`test-jobspy.mjs`](../../test-jobspy.mjs) (29 cases)
> - Doctor: `JobSpy runner` check in [`doctor.mjs`](../../doctor.mjs)
> - Install bootstrap: [`marketing/install.sh`](https://github.com/nerdywhiskers/CareerBot/blob/marketing/marketing/install.sh) and `install.ps1` (on the `marketing` branch) install `uv` automatically
>
> Phases 2 and 3 of the original spec (dedicated dashboard tab,
> onboarding cross-pollination) remain deferred — the current SSE
> integration delivers the core value with less surface area.

A separate scan mode that complements the curated ATS scan by querying
job aggregators (Indeed, Google Jobs, Glassdoor, ZipRecruiter, optionally
LinkedIn) via [JobSpy](https://github.com/speedyapply/JobSpy) as a Python
sidecar. Surfaces roles at companies the user doesn't yet track and
promising employers worth adding to `portals.yml`.

## Goal

Run a market-wide job search across the major aggregators using JobSpy.
**Complement, not replace** the curated ATS scan: discovery, not daily
monitoring.

## Design principles

- **Curated ATS scan stays the primary signal.** Market mode is for
  discovery, not daily monitoring.
- **No noise into `pipeline.md`.** Market hits land in a separate file
  (`data/market.md`) and require explicit triage to be promoted.
- **Agent-mediated triage.** Raw aggregator hits are noisy — the agent
  reads, filters by archetype/profile fit, and surfaces a short list
  rather than dumping 200 rows.
- **Legal-grey-area defaults.** LinkedIn scraping is risky (ToS, *hiQ
  v. LinkedIn* aftershocks). Default sources skip LinkedIn; opt-in flag
  if the user accepts the risk.
- **Python is a first-class boundary.** Subprocess only — no
  long-running service, no FastAPI sidecar.

## File layout

```
market.mjs                          ← NEW: Node CLI; wraps Python sidecar, dedupes, filters
scan/market/
  jobspy_wrapper.py                 ← NEW: ~50 LOC Python script invoking jobspy.scrape_jobs and printing JSON
  market-core.mjs                   ← NEW: pure functions for dedup / filter / group-by-company
data/
  market.md                         ← NEW (gitignored): triage queue, separate from pipeline.md
  market-cache.json                 ← NEW (gitignored): 30min cache by (query,sites) hash
modes/market.md                     ← NEW: agent prompt for /careerbot market
docs/design/MARKET_DISCOVERY.md     ← THIS FILE
test-market.mjs                     ← NEW: unit tests on JSON fixtures
doctor.mjs                          ← MODIFIED: add Python + jobspy version check
config/profile.example.yml          ← MODIFIED: add preferences.market block
.gitignore                          ← MODIFIED: data/market.md, data/market-cache.json
package.json                        ← MODIFIED: add "market" script
```

## Python sidecar

`scan/market/jobspy_wrapper.py` is intentionally tiny — JobSpy does
the heavy lifting; everything else lives in Node where the rest of the
project is.

```python
# Reads JSON config from stdin, writes JSON results to stdout.
import sys, json
from jobspy import scrape_jobs

cfg = json.load(sys.stdin)
df = scrape_jobs(
    site_name=cfg["sites"],
    search_term=cfg["query"],
    location=cfg.get("location", ""),
    results_wanted=cfg.get("results_per_site", 25),
    hours_old=cfg.get("hours_old", 168),
    is_remote=cfg.get("remote", False),
    country_indeed=cfg.get("country_indeed", "USA"),
)
records = df.to_dict(orient="records") if not df.empty else []
print(json.dumps({"jobs": records, "count": len(records)}, default=str))
```

## Node CLI

`market.mjs` flags:

```
node market.mjs                        # default: pull query+location from profile.yml
node market.mjs --query "ML engineer"  # override profile query
node market.mjs --location "Berlin, DE"
node market.mjs --remote               # is_remote=true
node market.mjs --hours 24             # only last 24h
node market.mjs --sites indeed,google  # override default site list
node market.mjs --with-linkedin        # opt-in for LinkedIn (off by default)
node market.mjs --limit 25             # results_per_site
node market.mjs --json                 # machine-readable to stdout (for the dashboard)
node market.mjs --no-cache             # bypass 30min cache
node market.mjs --suggest-companies    # auto-add new companies to portals.yml as enabled:false
```

### Default flow

1. Read `config/profile.yml` → query + location + sites.
2. Hash the query → check `data/market-cache.json` for fresh result
   (≤30min) unless `--no-cache`.
3. Spawn `python jobspy_wrapper.py`, pipe config in, parse JSON out.
4. Dedupe by URL + by `(company, title)` — using the same
   `normalizeUrl()` from `scan.mjs`.
5. Cross-check against `pipeline.md`, `applications.md`,
   `scan-history.tsv`, `portals.yml` so existing items get a
   `seen_in_pipeline: true` flag (not dropped — context for the agent).
6. Apply `buildTitleFilter()` from `scan.mjs` (positive/negative
   keywords from `portals.yml > title_filter`).
7. Group by company. Compute "tracked / not tracked / disabled" status
   from `portals.yml`.
8. Write `data/market.md` (markdown table sorted by recency) + cache JSON.
9. Print summary to stdout.

## Output format — `data/market.md`

```markdown
# Market Discovery — 2026-05-01

## Companies you don't currently track

### Anthropic — 3 hits (NOT in portals)
- Senior ML Engineer | San Francisco, CA | $250k–$400k | LinkedIn,Indeed | https://...
- Research Engineer | Remote | $300k–$450k | Glassdoor | https://...
- ...

### Cohere — 2 hits (in portals, scan-history covered 1)
- Founding Engineer, Inference | Toronto | $200k–$320k | Indeed | https://...

## Hits at tracked companies (already covered by ATS scan or in pipeline)

| Company | Role | Source | Status |
|---|---|---|---|
| Anthropic | Senior ML Eng | LinkedIn | already in pipeline.md |
```

## Mode prompt — `modes/market.md`

The agent's job on `/careerbot market`:

1. Read `config/profile.yml` and `data/market.md` (latest).
2. For each new company: cross-check against archetypes in
   `modes/_profile.md`. Score fit (1–5).
3. Generate a triage report:
   - **Top picks**: top 5 hits ranked by archetype × seniority × comp
     signal.
   - **Companies worth tracking**: ones with ≥2 hits at relevant titles.
   - **Skip**: low-signal hits (consultancies, recruiters,
     off-archetype).
4. Ask the user: *"Add these N companies to portals.yml?"* / *"Send
   these M roles to pipeline.md for evaluation?"*
5. On confirm, mutate `portals.yml` (W1 health-check the additions)
   and/or append to `pipeline.md`.

## doctor.mjs additions

```js
function checkPython() {
  // python3 first, then python (Windows ships `python` but not `python3`)
  // Require ≥3.10 (jobspy's floor)
}

function checkJobSpy() {
  // python -c "import jobspy; print(jobspy.__version__)"
  // Pin to a known-working version range; warn if outside.
}
```

Both are **optional checks** — only fail `npm run doctor` if the user
has run `/careerbot market` recently or `preferences.market.enabled:
true`. Otherwise warn-only.

## config/profile.yml additions

```yaml
preferences:
  market:
    enabled: false                 # explicit opt-in; doctor stays quiet otherwise
    sites: [indeed, google, zip_recruiter, glassdoor]
    with_linkedin: false           # legal/risk opt-in
    results_per_site: 25
    hours_old: 168                 # past week
    country_indeed: USA            # Indeed needs explicit country
    auto_promote_companies: false  # never silently mutate portals.yml
```

## Phasing

| Phase | Scope | LOC | Time |
|---|---|---|---|
| **Phase 1 — CLI core** | `market.mjs` + Python wrapper + `market-core.mjs` + tests + doctor checks + `modes/market.md` + docs | ~450 | 3–4h |
| **Phase 2 — Dashboard tab** | New "Market" tab; query form, results table, "Add to portals" / "Send to pipeline" actions; reuses Phase 1 Node API | ~400 | 3h |
| **Phase 3 — Onboarding cross-pollination** | During W2 onboarding, run market discovery for user's role+region; surface companies with *current* openings as preferred suggestions | ~150 | 2h |

Phase 1 alone delivers value: agent can use it via `/careerbot market`.
Phase 2 makes it dashboard-native. Phase 3 makes onboarding smarter.

## Tests

**`market-core.mjs` unit tests** (no Python, no network):

- Dedup: same job on LinkedIn + Indeed + Glassdoor → one entry, three
  sources.
- Cross-pipeline match: hit URL exists in `scan-history.tsv` → flagged
  `already_seen`.
- Group-by-company: 3 hits at same company → one group with `count: 3`.
- Title filter: positive/negative keywords reuse `scan.mjs`'s
  `buildTitleFilter`.
- Cache: identical query within 30min → cache hit; older → cache miss.

**Integration:**

- Doctor recognizes missing Python and missing jobspy with actionable
  hints.
- `--suggest-companies` flag's `portals.yml` mutation produces a clean
  diff (`enabled: false`, provenance note, no field clobbering).

**Manual smoke (live):**

- `node market.mjs --query "ML engineer" --limit 5 --sites indeed`
- Verify ≥1 hit, dedup works against pipeline, file format clean.

## Risks + decisions to flag

1. **LinkedIn scraping is grey.** Default off. Document the *hiQ v.
   LinkedIn* context here so the user understands the tradeoff before
   flipping `--with-linkedin`.
2. **Python dependency.** First-time setup requires `pip install
   python-jobspy` outside the Node ecosystem. Doctor surfaces it; mode
   prompt's first run can offer to print the install command.
3. **JobSpy version drift.** JobSpy is on v1.1.79+ with frequent
   releases. Pin to a tested range (`>=1.1.70,<2.0`) and bump
   deliberately.
4. **Aggregator output schema drift.** Indeed/Google/etc. occasionally
   change page structure → JobSpy breaks until they patch. Catch
   ImportError + parse failures and log "JobSpy version may need
   update."
5. **Rate limits without proxies.** Default `results_per_site: 25`
   keeps us well under everyone's threshold. If the user hits limits,
   document JobSpy's `proxies` parameter (we won't ship one).
6. **`data/market.md` accumulating cruft.** Each run overwrites (not
   appends) — last-N-runs only. If the user wants history, that's
   `scan-history.tsv`'s job.

## What this is NOT

- **Not a replacement for `/careerbot scan`.** The curated ATS scan
  stays the primary daily flow.
- **Not auto-merge into `pipeline.md`.** Aggregator noise would dilute
  the signal.
- **Not a long-running service.** Subprocess only.
- **Not an "apply" target.** Discovered roles flow through normal
  evaluate → apply paths after triage.

## Legal note — LinkedIn

LinkedIn aggressively pursues automated scrapers. The 2022 *hiQ Labs v.
LinkedIn* ruling held that scraping public profiles wasn't a CFAA
violation, but LinkedIn has since expanded ToS-based countermeasures
(IP blocks, account bans, civil suits in non-CFAA jurisdictions) and
the case-law landscape continues to shift. Defaults in this mode skip
LinkedIn; flipping `with_linkedin: true` is a deliberate choice the
user makes for themselves.
