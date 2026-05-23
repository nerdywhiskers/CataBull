# Portals audit (one-shot, local-only)

Cross-checks `portals.yml` against the live job market via
[JobSpy](https://github.com/speedyapply/JobSpy). Produces a triage
report at `docs/audit/portals-audit-YYYY-MM-DD.md`:

- **A1.** Landing-page portals JobSpy thinks have fresh hits — likely
  wrong URL, suggested fix included.
- **A2.** ATS-endpoint portals with no JobSpy activity — probably fine,
  noted for completeness.
- **B.** Dormant portals — landing-page-shaped AND no JobSpy hits.
- **C.** New-company candidates — companies in JobSpy results that
  aren't in `portals.yml`, ranked top 50.
- **D.** Summary stats (queries run, hit counts, failed sources).

`portals.yml` is **never auto-edited**. Apply fixes by hand from the
report.

## What this is NOT

This is not the deferred `/catabull market` mode from
[docs/design/MARKET_DISCOVERY.md](../../docs/design/MARKET_DISCOVERY.md).
That feature ships Python to every user; this audit only runs on your
machine. The deferral spec is still the right home for the long-term
market discovery feature — this just borrows the Python wrapper for a
one-time housekeeping pass.

## Setup (once)

```sh
cd tools/audit
python -m venv .venv
.venv/Scripts/python.exe -m pip install "python-jobspy>=1.1.79,<2.0"
```

On macOS / Linux replace `.venv/Scripts/python.exe` with
`.venv/bin/python`. The venv lives at `tools/audit/.venv/` and is
gitignored. JobSpy needs Python ≥ 3.10.

## Run

```sh
node tools/audit/run-audit.mjs                          # full audit (~8 min)
node tools/audit/run-audit.mjs --cached                 # reuse last-results.json
node tools/audit/run-audit.mjs --dry-run                # classify portals only
node tools/audit/run-audit.mjs --no-linkedin            # Indeed-only (~1 min)
node tools/audit/run-audit.mjs --terms-file path.json   # override the bank
```

## Query bank

The default bank is a curated ~18-term list covering CataBull's
target audience broadly — engineering, design, data/ML, product,
DevRel. It is **not** derived from any one user's profile because the
audit is verifying a shared `portals.yml`; the queries should reflect
what the project at large hires for, not what the running user wants.
See `DEFAULT_TERMS` in `run-audit.mjs` for the exact list.

For one-off audits (e.g. "find me companies hiring designers in
Berlin"), pass `--terms-file my-terms.json` where the file is a JSON
or YAML array of search strings.

Each term runs against:
- **Indeed** — primary signal. Returns `job_url_direct`, which is the
  real ATS URL we use to suggest fixes in section A1 and seed new
  portals in section C.
- **LinkedIn** — discovery breadth. Doesn't return `job_url_direct`,
  so LinkedIn-only candidates need a manual ATS lookup.

Per-site delays: 2s between Indeed queries, 5s between LinkedIn
queries (LinkedIn's bot detection trips on tight loops). Pass
`--no-linkedin` to skip the slow phase entirely.

## Sources

| Source | Status (probed 2026-05-13) | Why |
|---|---|---|
| **Indeed** | ✅ working, includes `job_url_direct` | Primary signal for A1 |
| **LinkedIn** | ✅ working, no `job_url_direct` | Discovery only |
| Google Jobs | broken upstream | JobSpy scraper not returning hits |
| Glassdoor | API error | JobSpy 1.1.82 + Glassdoor |
| ZipRecruiter | 403 bot-blocked | — |

If Glassdoor / Google / ZipRecruiter come back upstream, add them to
`buildQueryPlan` in `run-audit.mjs`.

## Files

```
tools/audit/
├── README.md            ← this file
├── jobspy_audit.py      ← thin Python wrapper; stdin→stdout JSON
├── run-audit.mjs        ← Node orchestrator; classify + report
├── resolve-urls.mjs     ← second pass; fetch HTML, find ATS markers
├── apply-patches.mjs    ← third pass; line-edit portals.yml + template
├── probe.py             ← tiny per-site sanity probe, used during setup
├── .venv/               ← gitignored; pip-installed JobSpy lives here
├── last-results.json    ← gitignored; raw JobSpy output from last run
└── resolved-urls.json   ← gitignored; resolver output for the applier
```

## Three-stage flow

1. **Audit** — `node tools/audit/run-audit.mjs` runs the JobSpy queries
   and writes the triage report. This is where you find out *which* portals
   need attention.
2. **Resolve** — `node tools/audit/resolve-urls.mjs` reads the cached
   audit, fetches each landing-page portal's HTML, and looks for embedded
   ATS markers (Greenhouse iframe, Ashby script tag, Lever link, Workday
   URL pattern, etc.). Buckets each into `use_ats`, `use_websearch_fallback`,
   or `manual`. Writes `resolved-urls.json` + a companion markdown report.
3. **Apply** — `node tools/audit/apply-patches.mjs --apply` consumes the
   resolver output and edits both `portals.yml` and
   `templates/portals.example.yml` line-by-line (preserving comments).
   Writes `.bak` files alongside each modified target. Defaults to
   dry-run; use `--apply` to commit. Scope with `--portals-only` or
   `--template-only`.

The applier never edits anything outside the resolver's `use_ats` and
`use_websearch_fallback` buckets — `manual` entries (LinkedIn-only
candidates with no `job_url_direct`, unreachable pages, ambiguous
patterns) stay in the report for human triage.

## Caveats

- LinkedIn scraping is in legal grey territory (*hiQ v. LinkedIn* and
  aftershocks). This audit runs from your machine, infrequently, with
  reasonable delays. Don't loop it.
- JobSpy versions break aggregator scrapers on a regular schedule. If
  a re-run six months from now returns zero hits across all sources,
  bump JobSpy and re-probe with `tools/audit/probe.py`.
- Indeed's `country_indeed` defaults to `USA`. Edit `buildQueryPlan`
  if your search should be region-specific.
