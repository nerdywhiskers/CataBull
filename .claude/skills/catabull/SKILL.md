---
name: catabull
description: CataBull job-search pipeline command router. Invoked as `/catabull <mode> [target]` from the dashboard chat or terminal (e.g. `/catabull evaluate <url>`, `/catabull scan`, `/catabull pipeline`). Routes each mode to its `modes/*.md` workflow, loading `modes/_shared.md`, `modes/_profile.md`, and `modes/humanizer.md` as the workflow requires. Use whenever the user types a `/catabull` command or asks to run a CataBull workflow (evaluate an offer, scan portals, process the pipeline, generate a CV/PDF, research a company, prep an interview, find contacts, analyze patterns or follow-ups, track applications).
---

# CataBull command router

CataBull is the AI job-search pipeline in this repo. A `/catabull <mode>`
command maps to one workflow file under `modes/`. Your job: identify the
mode, read the files that mode needs, then execute the workflow exactly as
that file describes.

## Always-on rules

- **Before writing any user-facing text** (reports, outreach, CV content,
  application answers) read `modes/humanizer.md` and apply its voice.
- **Read metrics from source** — `cv.md` and `article-digest.md`. Never
  hardcode numbers.
- **Personalization lives in the user layer.** Customizations go in
  `modes/_profile.md` or `config/profile.yml`, never in `modes/_shared.md`.
- **Never submit an application without the user reviewing it first.**
- **Verify offers with Playwright**, not WebSearch/WebFetch (navigate +
  snapshot; title + description + Apply = active).

## Mode routing

Parse the first token after `/catabull` as the mode; the rest is the target
(URL, company, or pasted text).

| Mode | File(s) to read first | What it does |
|------|----------------------|--------------|
| `auto-pipeline` | `_shared.md` + `_profile.md` + `auto-pipeline.md` | Evaluate pasted JD/URL in one pass (report + PDF + tracker) |
| `evaluate` | `_shared.md` + `_profile.md` | Score a role (A–G), draft tailored CV on strong fit; save `reports/{###}-{company-slug}-{YYYY-MM-DD}.md` |
| `pdf` | `_shared.md` + `pdf.md` | Generate tailored CV via `templates/cv-template.html` + `generate-pdf.mjs` |
| `apply` | `_shared.md` + `apply.md` | Live application assistant (Playwright form fill, present answers for review) |
| `interview-prep` | `interview-prep.md` | Build interview prep; pull from `interview-prep/story-bank.md` |
| `outreach` | `outreach.md` | Find contacts, draft LinkedIn intros under `data/outreach/` |
| `training` | `training.md` | Assess a course/certification |
| `project` | `project.md` | Assess a portfolio project |
| `pipeline` | `pipeline.md` | Process pending URLs in `data/pipeline.md` |
| `scan` | `scan.md` | Scan portals for new offers (zero-token via `scan.mjs`) |
| `batch` | `_shared.md` + `batch.md` | Batch-process multiple roles |
| `deep` | `deep.md` | 6-axis company research (WebSearch/WebFetch) |
| `tracker` | `tracker.md` | Review `data/applications.md` + stats |
| `patterns` | `patterns.md` | Rejection-pattern analysis (`analyze-patterns.mjs`) |
| `followup` | `followup.md` | Follow-up urgency + next steps (`followup-cadence.mjs`) |

If the mode is unrecognized, list the modes above and ask which the user
meant. After a batch of evaluations, run `node merge-tracker.mjs`.

## Tracker discipline

- Canonical states are defined in `templates/states.yml`.
- **Never create a duplicate entry** in `data/applications.md` for an
  existing company+role — update the existing row.
