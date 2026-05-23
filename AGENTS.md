# CataBull -- AI Job Search Pipeline

## What is CataBull

AI-powered job search dashboard and automation built on Claude Code. Includes a web dashboard with integrated terminal, pipeline tracking, offer evaluation, CV generation, portal scanning, and batch processing.

**Start the dashboard:** `npm run dashboard` or double-click `start.bat` (Windows) / `start.command` (Mac) → http://localhost:3737

## Data Contract (CRITICAL)

There are two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (NEVER auto-updated, personalization goes HERE):**
- `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer (auto-updatable, DON'T put user data here):**
- `modes/_shared.md`, all other modes
- `CLAUDE.md`, root `*.mjs` wrappers, `scripts/*`, `tests/*`, `dashboard-web/*`, `templates/*`, `batch/*`

**THE RULE: When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), ALWAYS write to `modes/_profile.md` or `config/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content.**

### Main Files

| File | Function |
|------|----------|
| `dashboard-web/` | Web dashboard (Fastify + vanilla JS) |
| `data/applications.md` | Application tracker |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `portals.yml` | Query and company config |
| `templates/cv-template.html` | HTML template for CVs |
| `templates/cv-template.tex` | LaTeX/Overleaf template for CVs |
| `generate-pdf.mjs` | Playwright: HTML to PDF |
| `generate-latex.mjs` | LaTeX CV validator + pdflatex compiler |
| `scan.mjs` | Zero-token portal scanner -- hits Greenhouse/Ashby/Lever APIs directly |
| `analyze-patterns.mjs` | Pattern analysis script (JSON output) |
| `followup-cadence.mjs` | Follow-up cadence calculator (JSON output) |
| `scripts/` | Implementations behind the root `.mjs` compatibility wrappers |
| `tests/` | Test suite implementations |
| `reports/` | Evaluation reports (format: `{###}-{company-slug}-{YYYY-MM-DD}.md`) |
| `data/outreach/` | Contact discovery & LinkedIn intro drafts per company |

### First Run -- Onboarding

**Before doing ANYTHING else, check if the system is set up.** Run these checks silently every time a session starts:

1. Does `cv.md` exist?
2. Does `config/profile.yml` exist (not just profile.example.yml)?
3. Does `modes/_profile.md` exist (not just _profile.template.md)?
4. Does `portals.yml` exist (not just templates/portals.example.yml)?

If `modes/_profile.md` is missing, copy from `modes/_profile.template.md` silently.

**If ANY of these is missing, enter onboarding mode.** The web dashboard also has an onboarding wizard at http://localhost:3737 that handles this visually.

### Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline (evaluate + report + PDF + tracker) |
| Asks to evaluate offer | `evaluate` (reads `modes/_shared.md` + `modes/_profile.md`) |
| Asks for company research | `deep` |
| Preps for interview | `interview-prep` |
| Wants to generate CV/PDF | `pdf` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns | `patterns` |
| Asks about follow-ups | `followup` |
| Wants to find contacts / draft LinkedIn intros | `outreach` |
| Writing any user-facing text | Always apply `humanizer` rules |

### Writing Style

**ALWAYS read `modes/humanizer.md` before writing any user-facing text** (reports, outreach messages, CV content, application answers). It defines the writing voice: natural, specific, no em dashes, no corporate buzzwords, no AI-sounding patterns.

### CV Source of Truth

- `cv.md` in project root is the canonical CV
- `article-digest.md` has detailed proof points (optional)
- **NEVER hardcode metrics** -- read them from these files at evaluation time

### Personalization

This system is designed to be customized by the AI Agent. When the user asks you to change archetypes, adjust scoring, add companies, or modify negotiation scripts -- do it directly.

**Common customization requests:**
- "Change the archetypes" → edit `modes/_profile.md` or `config/profile.yml`
- "Add these companies to my portals" → edit `portals.yml`
- "Update my profile" → edit `config/profile.yml`
- "Change the CV template design" → edit `templates/cv-template.html`

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.**

- **NEVER submit an application without the user reviewing it first.**
- **Strongly discourage low-fit applications.** If a score is below 4.0/5, recommend against applying.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50.
- **Respect recruiters' time.** Only send what's worth reading.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** ALWAYS use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without JD = closed. Title + description + Apply = active.

**Exception for batch workers (`claude -p`):** Use WebFetch as fallback and mark `**Verification:** unconfirmed (batch mode)`.

---

## Stack and Conventions

- Node.js (mjs modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data)
- Fastify (dashboard-web server), xterm.js + node-pty (terminal), vanilla JS (frontend)
- Scripts in `.mjs`, configuration in YAML
- Output in `output/` (gitignored), Reports in `reports/`
- Report numbering: sequential 3-digit zero-padded, max existing + 1
- **RULE: After each batch of evaluations, run `node merge-tracker.mjs`** to merge tracker additions.
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |
