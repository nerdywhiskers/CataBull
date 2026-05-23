# Architecture

A snapshot of how CataBull is wired today (2026-05-08, post-v1.4
merge). For the deeper "why" behind specific subsystems see the design
docs in `docs/design/`; for the strategic direction see

## System overview

```
                        ┌──────────────────────────────────────────────┐
                        │  CLI agent (any of: Claude Code · Codex ·    │
                        │  OpenCode · Gemini · Hermes · OpenClaw) —     │
                        │  drawer or as a headless subprocess.         │
                        └─────────────────┬────────────────────────────┘
                                          │
   ┌──────────────────────────────────────┼─────────────────────────────────────┐
   │                                      │                                     │
┌──▼────────────────┐         ┌───────────▼──────────────┐         ┌────────────▼─────────────┐
│  Onboarding (W7)  │         │  Discover / Pipeline /   │         │  Health checks (W1/W4),  │
│  CV → archetypes  │         │  Tailor / Evaluate flows │         │  URL recovery (W8),      │
│  → verified discovery       │  (per-role agent runs)   │         │  scheduled scans         │
│  → portals.yml seed         └──────────┬───────────────┘         └────────────┬─────────────┘
└──────────┬────────┘                    │                                      │
           │                             ▼                                      ▼
           │        ┌───────────────────────────────────────────────────────────────────┐
           │        │              Workspace (lib/workspace.mjs)                         │
           └───────▶│  read · write · readYaml · writeYaml · copy · delete · mkdir · list│
                    │  Resolved at startup by lib/workspace-resolver.mjs:                │
                    │    env CATABULL_WORKSPACE_ROOT > cwd-with-markers > project-tree  │
                    │    > ~/.catabull/  (CLI default)                                 │
                    └────────────────────────────┬───────────────────────────────────────┘
                                                 │
                                                 ▼
                  ┌──────────────────────────────────────────────────────────┐
                  │   User data on disk (gitignored, owned by the user):     │
                  │     cv.md · config/profile.yml · modes/_profile.md       │
                  │     portals.yml · article-digest.md                      │
                  │     data/applications.md · data/pipeline.md              │
                  │     data/scan-history.tsv · data/scan-health.json        │
                  │     reports/ · output/ (incl. tailor-bundles/)           │
                  │     interview-prep/                                      │
                  │     .profiles/ ← multi-profile archive                   │
                  └──────────────────────────────────────────────────────────┘
```

The two layers that matter for everything else:

- **Workspace** answers *where data lives*. Single abstraction; today
  only `LocalWorkspace` exists, but the surface is shaped so a future
  `S3Workspace` (Phase 2 hosted) drops in without modes or routes
  changing.
- **user-data** (`dashboard-web/lib/user-data.mjs`) answers *what
  counts as data*. Defines `USER_PATHS` and the multi-profile archive
  / restore flows.

See `docs/design/WORKSPACE_AND_PROFILES.md` for how the two compose.

## Three primary user flows

### Onboarding (one-time)

1. User uploads CV (PDF / DOCX / MD) on the dashboard
2. Agent extracts profile fields + cleans CV markdown (1 LLM call)
3. Agent generates archetypes / narrative / proof points (1 LLM call)
4. **W7 verified discovery** — agent proposes ~25 candidate companies
   (names only); per-candidate verifier runs WebSearch + sniffer +
   health check + role-fit pre-flight in parallel (concurrency 5).
   Survivors land enabled in `portals.yml`; failures land disabled
   with the specific reason
5. Initial scan runs, lands the user on the Discover tab

Code paths:
- `dashboard-web/routes/onboarding.mjs > /onboarding/discover-companies`
- `lib/discovery.mjs` (orchestrator)
- `lib/title-filter.mjs` (role-fit predicate, shared with `scan.mjs`)

### Active job-search loop

1. Daily / on-demand portal scan via `scan.mjs` finds new postings,
   appends to `data/pipeline.md` + `data/scan-history.tsv`
2. **Discover tab** card-grid renders pending postings sorted by fit
   score (heuristic in `lib/relevance.mjs`); each card shows the
   rationale in a tooltip
3. User clicks **Tailor** on a high-fit card → server orchestrates
   one agent call that returns CV + cover letter + Q&A as a JSON
   payload; written to `output/tailor-bundles/{slug}/`
4. Or **Evaluate** for the full A–E rubric (CV match, North Star,
   comp, cultural fit, red flags) → report saved to `reports/`
5. User reviews, edits, applies — then marks the role applied,
   which flows into `data/applications.md`

Code paths:
- `scan.mjs` + `scan/providers/` (six ATS providers + webfetch + W5 sniffer)
- `dashboard-web/routes/applications.mjs` (Pipeline data + relevance enrichment)
- `dashboard-web/routes/tailor.mjs` + `lib/tailor.mjs`
- `modes/evaluate.md`, `modes/auto-pipeline.md`

### Maintenance loop

1. Scheduled or manual **scan-health** check classifies every tracked
   portal (eight statuses per W1)
2. Three consecutive failures auto-disable a company (W4 decay)
3. The user clicks **Find new URL** on the Health tab → scoped W8
   recovery runs the W7 pipeline against just that one name → confirm
   modal proposes the resolved URL with role-fit context → on accept,
   `careers_url` is rewritten, `auto_disabled` cleared, failure
   counter reset

Code paths:
- `scan/health.mjs` (classifier + decay state machine)
- `dashboard-web/routes/health.mjs` (snapshot, recheck, recover)
- W5 sniffer at `scan/providers/sniff.mjs` reused inside the verifier

## Evaluation flow (single offer)

1. **Input** — User pastes a JD or URL into the chat drawer
2. **Extract** — Playwright (`generate-pdf.mjs` shares the chromium
   pool) or WebFetch pulls the JD
3. **Classify** — Detect archetype against `modes/_profile.md`'s
   archetype table (user-defined, count varies)
4. **Evaluate** — A–E rubric per `modes/_shared.md`:
   - **A** Match con CV (weight 0.30)
   - **B** North Star fit (0.25)
   - **C** Comp signal (0.20)
   - **D** Cultural fit (0.15)
   - **E** Red flags (0.10 penalty)
5. **Score** — Weighted sum, surfaced everywhere via `lib/relevance.mjs`
   + `parseBlockScores` in `dashboard-web/lib/parsers.mjs`
6. **Report** — Saved as `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`
7. **PDF** — Tailored CV via `generate-pdf.mjs` (HTML template +
   headless Chromium); ATS-safe Unicode normalization
8. **Track** — Append to `data/applications.md` (or batch via
   `merge-tracker.mjs`)

## Batch processing

`batch/batch-runner.sh` orchestrates parallel evaluations of pending
URLs through `claude -p` (or other agent --print) workers. Each
worker is headless, gets the full `batch/batch-prompt.md` as context,
and emits:

- A report markdown
- A PDF
- A tracker TSV line in `batch/tracker-additions/{id}.tsv`

`merge-tracker.mjs` later folds the TSVs into `data/applications.md`
without duplicates.

## Dashboard

The dashboard at <http://localhost:3737> is a Fastify server with a
vanilla-JS frontend (no build step).

```
dashboard-web/
├── server.mjs              ← entry point; resolves workspace, registers routes
├── lib/                    ← server-side helpers (writers, parsers, agents,
│                              user-data, scheduler, metrics, memory)
├── routes/                 ← 14 route modules, all under /api/v1
└── public/                 ← static frontend (HTML + CSS + ES modules)
    ├── index.html
    ├── css/                ← Catppuccin Mocha + Latte themes
    ├── js/
    │   ├── app.mjs         ← view router, hash-based
    │   ├── api.mjs         ← /api/v1 client wrapper
    │   ├── views/          ← per-tab views (pipeline, discover, portals,
    │   │                      profile, progress/analytics, onboarding,
    │   │                      chat/terminal drawer, etc.)
    │   ├── lib/            ← browser-side helpers (modes, ansi, session-conflict,
    │   │                      discover-grouping)
    │   └── components/     ← toast, confirm modal, markdown renderer, ...
    └── vendor/             ← marked.min.js, xterm.min.js, fit addon
```

The chat drawer docks on the right side and persists across views.
It runs whichever agent the user picked in their profile
(`preferences.agent`). Agent invocations have two paths:

- **In-drawer** (interactive): renders streaming output, supports
  session continuation, auto-retries on session conflicts
- **Headless** (server-side): `runAgentPrint` in `dashboard-web/lib/agents.mjs`
  spawns the CLI as a subprocess, captures output, returns to the
  caller. Used by Tailor, W7 verification, profile generation, etc.

## File naming conventions

- Reports: `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` (3-digit zero-padded; sequential)
- PDFs: `output/cv-candidate-{company-slug}-{YYYY-MM-DD}.pdf`
- Tailor bundles: `output/tailor-bundles/{company}-{role}-{date}/{cv,cover-letter,answers}.md`
- Tracker TSVs: `batch/tracker-additions/{id}.tsv`
- Profile archives: `.profiles/{id}/` (mirrors USER_PATHS layout)

## Pipeline integrity

The data layer is markdown + YAML + TSV on disk; no database. Several
scripts maintain consistency:

| Script | Purpose |
|---|---|
| `verify-pipeline.mjs` | 7-rule integrity check on `data/applications.md` |
| `merge-tracker.mjs` | Folds batch TSV additions in, dedupes |
| `dedup-tracker.mjs` | Removes duplicates by company + fuzzy role match |
| `normalize-statuses.mjs` | Maps status aliases to canonical states (`templates/states.yml`) |
| `cv-sync-check.mjs` | Validates CV / profile internal consistency |
| `scan-health.mjs` | W1 classifier + W4 decay state machine |

## Stack

- **Backend** — Fastify 5 (Node 18+), `node-pty` for terminal sessions,
  Playwright for headless Chromium (PDF generation, scraping fallback)
- **Frontend** — vanilla JS + ES modules, no build step. Catppuccin
  themes. xterm.js for the terminal drawer.
- **Scanner** — direct API calls to Greenhouse / Ashby / Lever /
  Workday / BambooHR / Teamtailor (zero LLM cost). Webfetch fallback
  with W5 outbound-link sniffer for branded careers pages.
- **Agent layer** — CLI subprocesses (Claude Code / Codex / OpenCode /
  Gemini / Hermes / OpenClaw); user picks one via the dashboard. No vendor lock-in.
- **Distribution** — GitHub-backed npm install (`npm install -g github:your-github-user/catabull`) plus install scripts; `catabull` CLI scaffolds `~/.catabull/` on first run.
- **Data** — markdown tables, YAML configs, TSV scan history. No DB.
- **Tests** — unit and smoke suites under `tests/`; `package.json` defines the current `npm run test:unit` subset and `npm test` integration smoke entry. Pure logic; no live network in tests.

## Design references

- `docs/design/WORKSPACE_AND_PROFILES.md` — workspace abstraction + multi-profile composition
- `docs/design/MARKET_DISCOVERY.md` — W6 JobSpy market discovery (deferred)
