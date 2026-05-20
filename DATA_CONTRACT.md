# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `article-digest.md` | Your proof points from portfolio |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `portals.yml` | Your customized company list |
| `memory/` | Agent-learned memory, auditable and editable |
| `data/applications.md` | Your application tracker |
| `data/pipeline.md` | Your URL inbox |
| `data/scan-history.tsv` | Your scan history |
| `data/follow-ups.md` | Your follow-up history |
| `data/outreach/` | Your contact discovery and outreach drafts |
| `reports/*` | Your evaluation reports |
| `output/*` | Your generated PDFs |
| `jds/*` | Your saved job descriptions |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/followup.md` | Follow-up cadence instructions |
| `modes/humanizer.md` | Writing style rules |
| `modes/interview-prep.md` | Interview preparation instructions |
| `modes/outreach.md` | Contact discovery and outreach instructions |
| `modes/patterns.md` | Pattern analysis instructions |
| `modes/pdf.md` | PDF generation instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/scan.md` | Portal scanner instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/training.md` | Training evaluation instructions |
| `CLAUDE.md` | Agent instructions |
| `*.mjs` | Backward-compatible root command wrappers |
| `scripts/*` | Utility script implementations |
| `tests/*` | Test suite implementations |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard-web/*` | Web dashboard |
| `templates/*` | Base templates |
| `.claude/skills/*` | Skill definitions |
| `docs/*` | Documentation |
| `VERSION` | Current version number |
| `DATA_CONTRACT.md` | This file |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
