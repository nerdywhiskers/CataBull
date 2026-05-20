# CareerBot

> Your job search, finally honest. Local-first dashboard, scanner, evaluator, and tailored application bundles built on Claude Code / Codex / OpenCode / Gemini / Hermes / OpenClaw.

Live site: [careerbot landing page](https://your-github-user.github.io/careerbot/)

## Install

**One-line install** — bootstraps Node 18+ via [`fnm`](https://github.com/Schniz/fnm) if you don't already have it, then installs CareerBot and runs first-run setup. No admin / sudo needed.

```bash
# macOS / Linux
curl -fsSL https://your-github-user.github.io/careerbot/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://your-github-user.github.io/careerbot/install.ps1 | iex
```

Then run `careerbot` and open <http://localhost:3737>. First run scaffolds a workspace at `~/.careerbot/` and installs Playwright Chromium into your user cache.

**Prefer to see what you're running?** If you already have Node 18+ installed:

```bash
# One-shot — runs CareerBot without a permanent install
npx github:your-github-user/careerbot

# Or install once and reuse
npm install -g github:your-github-user/careerbot
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

## Supported CLI Agents

Onboarding requires a working CLI agent on `PATH`; the wizard asks you to pick one and run a quick test before continuing.

| Agent | Install hint |
|-------|--------------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | See [github.com/openai/codex](https://github.com/openai/codex) |
| OpenCode | `npm install -g opencode-ai` |
| Gemini CLI | `npm install -g @google/gemini-cli` |
| Hermes Agent | `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \| bash` or see [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) |
| OpenClaw | `npm install -g openclaw@latest` or see [OpenClaw install docs](https://docs.openclaw.ai/install/index) |

### From source (development)

```bash
git clone https://github.com/your-github-user/careerbot.git
cd career-bot
npm run dashboard
```

Workspace defaults to the cloned directory so your data stays where the code is.

## Features

- **Discover** — card grid of all current postings across your tracked portals, sorted by fit score with rationale on every card
- **Tailor bundle** — one click → tailored CV + cover letter + 5–8 application Q&A, written in your voice from `cv.md` and `config/profile.yml`
- **Verified discovery** — onboarding's agent proposes companies, then verifies each careers URL via WebSearch + sniffer + role-fit pre-flight before they land in `portals.yml`
- **URL recovery** — one-click "Find new URL" for auto-disabled companies; agent re-discovers + role-fit checks; you accept or reject the proposal
- **Six ATS providers** — Greenhouse · Ashby · Lever · Workday · BambooHR · Teamtailor. Direct API access, zero LLM tokens for scanning. Webfetch fallback with outbound-link sniffer for branded careers pages
- **Health monitoring with auto-recovery** — periodic per-portal health checks; three consecutive failures auto-disable a company until you fix it
- **Deep evaluation** — A–E rubric (CV match, level strategy, comp research, cultural fit, red flags) with weighted score, comp targets, and STAR stories
- **Integrated terminal** — Claude Code / Codex / OpenCode / Gemini / Hermes / OpenClaw session docked to the dashboard, persistent across views
- **Local-first, MIT, no telemetry** — your CV, applications, target list never leave your machine

## Stack

- **Frontend**: vanilla JS + CSS, zero build step (Catppuccin Mocha/Latte themes)
- **Backend**: Fastify
- **Terminal**: xterm.js + node-pty (WebSocket)
- **Scanner**: direct API calls to ATS providers (zero LLM cost)
- **PDF**: Playwright headless Chromium
- **Data**: markdown + YAML on disk

## Workspace layout

```
~/.careerbot/
├── cv.md                      Your CV (markdown)
├── config/profile.yml         Target roles, narrative, archetypes
├── modes/_profile.md          Adaptive framing rules
├── portals.yml                Tracked companies + filters
├── data/
│   ├── applications.md        Application tracker
│   └── pipeline.md            Pending URLs
├── reports/                   Evaluation reports
└── output/
    └── tailor-bundles/        Per-role CV / cover letter / Q&A
```

## Documentation

Start at [docs/README.md](docs/README.md) for the doc index. Highlights:

- [Design](docs/design/) — `ARCHITECTURE.md` (current system snapshot), `WORKSPACE_AND_PROFILES.md` (workspace + multi-profile composition), `MARKET_DISCOVERY.md` (W6, deferred)
- [Guides](docs/guides/) — `SETUP.md`, `CUSTOMIZATION.md`, `SCRIPTS.md`

## Backup & sync (optional)

If you want your data versioned, fork this repo and repoint your local workspace at the fork. Dashboard works identically with or without a fork; your data is on disk either way.

## Landing page

Marketing site lives at [marketing/](marketing/). Preview locally with `npm run preview` (serves at <http://localhost:8080>).

To deploy to GitHub Pages, copy the template into place once and push (requires `workflow` OAuth scope):

```bash
gh auth refresh -h github.com -s workflow
mkdir -p .github/workflows
cp docs/deploy/pages-workflow.yml.template .github/workflows/pages.yml
git add .github/workflows/pages.yml
git commit -m "ci: deploy marketing/ to GitHub Pages"
git push
```

Then in the repo: **Settings → Pages → Source: GitHub Actions**. The site goes live at `https://<user>.github.io/career-bot/`.

## Built on

- [career-ops](https://github.com/santifer/career-ops) by santifer (original prototype)

## License

MIT — see [LICENSE](LICENSE)
