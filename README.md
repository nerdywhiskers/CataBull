<div align="center">

# CareerBot

Your local-first AI job search command center.

[Install](#install) | [Features](#features) | [Docs](docs/README.md) | [Setup](docs/guides/SETUP.md) | [Security](SECURITY.md)

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-PDF%20%2B%20scraping-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Fastify](https://img.shields.io/badge/Fastify-dashboard-000000?logo=fastify&logoColor=white)](https://fastify.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Local-first](https://img.shields.io/badge/local--first-no%20telemetry-7c3aed)](#features)

<img width="1937" height="1269" alt="image" src="https://github.com/user-attachments/assets/d3ad5bee-6a1b-4cc8-95ca-b0b240e1ab67" />

Live site: [careerbot landing page](https://nerdywhiskers.github.io/CareerBot/)

</div>

CareerBot is a local-first dashboard, scanner, evaluator, and tailored application bundle generator for serious job searches. It works with Claude Code, Codex, OpenCode, Gemini, Hermes, and OpenClaw, while keeping your CV, target list, reports, and application history on your machine.

## Install

**One-line install** - bootstraps Node 18+ via [`fnm`](https://github.com/Schniz/fnm) if you do not already have it, then installs CareerBot and runs first-run setup. No admin or sudo needed.

```bash
# macOS / Linux
curl -fsSL https://nerdywhiskers.github.io/CareerBot/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://nerdywhiskers.github.io/CareerBot/install.ps1 | iex
```

Then run `careerbot` and open <http://localhost:3737>. First run scaffolds a workspace at `~/.careerbot/` and installs Playwright Chromium into your user cache.

**Prefer to see what you are running?** If you already have Node 18+ installed:

```bash
# One-shot - runs CareerBot without a permanent install
npx github:nerdywhiskers/CareerBot

# Or install once and reuse
npm install -g github:nerdywhiskers/CareerBot
careerbot
```

The CLI also accepts subcommands:

```bash
careerbot setup          # bootstrap first-run dependencies, then run doctor
careerbot doctor         # validate setup
careerbot scan           # zero-token portal scan
careerbot scan-health    # health-check tracked companies
careerbot verify         # pipeline integrity check
careerbot --help
```

### From Source

```bash
git clone https://github.com/nerdywhiskers/CareerBot.git
cd CareerBot
npm install
npm run dashboard
```

Workspace defaults to the cloned directory so your data stays where the code is.

## Supported CLI Agents

Onboarding requires a working CLI agent on `PATH`; the wizard asks you to pick one and run a quick test before continuing.

| Agent | Install hint |
| --- | --- |
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | See [github.com/openai/codex](https://github.com/openai/codex) |
| OpenCode | `npm install -g opencode-ai` |
| Gemini CLI | `npm install -g @google/gemini-cli` |
| Hermes Agent | `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \| bash` or see [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) |
| OpenClaw | `npm install -g openclaw@latest` or see [OpenClaw install docs](https://docs.openclaw.ai/install/index) |

## Features

| Feature | What it does |
| --- | --- |
| Discover | Card grid of current postings across tracked portals, sorted by fit score with rationale on every card |
| Tailor bundle | One click creates a tailored CV, cover letter, and 5-8 application Q&A from `cv.md` and `config/profile.yml` |
| Verified discovery | Onboarding proposes companies, verifies careers URLs, and role-fit checks them before saving to `portals.yml` |
| URL recovery | One-click "Find new URL" flow for auto-disabled companies |
| ATS providers | Greenhouse, Ashby, Lever, Workday, BambooHR, and Teamtailor through direct APIs where possible |
| Health monitoring | Periodic portal health checks with auto-disable after repeated failures |
| Deep evaluation | A-E rubric for CV match, level strategy, compensation research, cultural fit, and red flags |
| Integrated terminal | Claude Code, Codex, OpenCode, Gemini, Hermes, or OpenClaw session docked inside the dashboard |
| Local-first | No telemetry; your CV, applications, reports, and target list stay on disk |

## Stack

- **Frontend:** vanilla JS + CSS, zero build step
- **Backend:** Fastify
- **Terminal:** xterm.js + node-pty over WebSocket
- **Scanner:** direct API calls to ATS providers, plus WebSearch fallback
- **PDF:** Playwright headless Chromium
- **Data:** Markdown, YAML, TSV, and JSON on disk

## Workspace Layout

```text
~/.careerbot/
|-- cv.md                      Your CV in Markdown
|-- config/profile.yml         Target roles, narrative, archetypes
|-- modes/_profile.md          Adaptive framing rules
|-- portals.yml                Tracked companies and filters
|-- data/
|   |-- applications.md        Application tracker
|   `-- pipeline.md            Pending URLs
|-- reports/                   Evaluation reports
`-- output/
    `-- tailor-bundles/        Per-role CV / cover letter / Q&A
```

## Documentation

Start at [docs/README.md](docs/README.md) for the doc index. Highlights:

- [Design](docs/design/) - `ARCHITECTURE.md`, `WORKSPACE_AND_PROFILES.md`, and `MARKET_DISCOVERY.md`
- [Guides](docs/guides/) - `SETUP.md`, `CUSTOMIZATION.md`, and `SCRIPTS.md`

## Backup And Sync

If you want your data versioned, fork this repo and repoint your local workspace at the fork. Dashboard works identically with or without a fork; your data is on disk either way.

## Landing Page

Marketing site lives at [marketing/](marketing/). Preview locally with `npm run preview` at <http://localhost:8080>.

To deploy to GitHub Pages, copy the template into place once and push. This requires the `workflow` OAuth scope:

```bash
gh auth refresh -h github.com -s workflow
mkdir -p .github/workflows
cp docs/deploy/pages-workflow.yml.template .github/workflows/pages.yml
git add .github/workflows/pages.yml
git commit -m "ci: deploy marketing/ to GitHub Pages"
git push
```

Then in the repo: **Settings -> Pages -> Source: GitHub Actions**. The site goes live at `https://<user>.github.io/CareerBot/`.

## Attribution

CareerBot is an independent project derived from [career-ops](https://github.com/santifer/career-ops), created by Santiago Fernandez de Valderrama. The `career-ops` name and brand remain with their maintainer and are referenced here only for attribution and lineage. CareerBot is not affiliated with, sponsored by, or endorsed by career-ops. See the [career-ops Trademark Policy](https://github.com/santifer/career-ops/blob/main/TRADEMARK.md) for details.

CareerBot also credits [JobSpy](https://github.com/speedyapply/JobSpy), the Python job scraping library used as a reference for broader job-board discovery patterns.

## License

MIT - see [LICENSE](LICENSE).
