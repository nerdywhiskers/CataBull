# Setup Guide

Two ways to install. The one-line run is the easiest path for most people. Clone from source if you want to read or modify the code.

## Prerequisites

- Node.js 18+
- A CLI agent installed and on `PATH`. Onboarding requires one for CV parsing, archetype generation, and the Tailor bundle. The scanner and PDF generation do not need an agent.

## Supported CLI Agents

The onboarding wizard detects these agents and requires a successful test before continuing:

| Agent | Install hint |
|-------|--------------|
| Claude Code | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | See [github.com/openai/codex](https://github.com/openai/codex) |
| OpenCode | `npm install -g opencode-ai` |
| Hermes Agent | `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \| bash` or see [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) |
| OpenClaw | `npm install -g openclaw@latest` or see [OpenClaw install docs](https://docs.openclaw.ai/install/index) |

## Option A: One-line install (recommended)

```bash
# macOS / Linux
curl -fsSL https://your-github-user.github.io/catabull/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://your-github-user.github.io/catabull/install.ps1 | iex
```

Then run `catabull` and open <http://localhost:3737>.

Why this is the default:

- Works on Windows, macOS, and Linux
- No repo clone
- Installs the `catabull` command globally from GitHub
- No admin permissions in the normal case
- First run scaffolds a workspace at `~/.catabull/` (override with `CATABULL_WORKSPACE_ROOT`)
- First run also installs Playwright Chromium into your user cache

The onboarding wizard at the dashboard walks you through CV upload, profile generation, portal selection, and an initial scan.

If you already have Node 18+ and want to inspect the install path first:

```bash
# One-shot from GitHub, no permanent install
npx github:your-github-user/catabull

# Or install once and reuse
npm install -g github:your-github-user/catabull
catabull
```

CLI subcommands once installed:

```bash
catabull setup          # bootstrap first-run dependencies, then run doctor
catabull doctor         # validate setup prerequisites
catabull scan           # zero-token portal scan
catabull scan-health    # health-check tracked companies
catabull verify         # pipeline integrity check
catabull --help
```

## Option B: From source (development)

```bash
git clone https://github.com/your-github-user/catabull.git
cd catabull
npm install
npm run dashboard
```

`npm run dashboard` now installs Playwright Chromium on first run if needed. Workspace defaults to the cloned directory so your data sits next to the code. Same onboarding wizard at <http://localhost:3737>.

## Manual setup (rarely needed)

Onboarding handles all of this through the dashboard, but if you'd rather edit files directly:

```bash
cp config/profile.example.yml config/profile.yml
cp templates/portals.example.yml portals.yml
# Then create cv.md in the project root with your CV in markdown.
```

Edit `config/profile.yml` for personal details (name, target roles, narrative, comp range), and `portals.yml` for tracked companies and title filters. The example files are heavily commented.

## Verify setup

```bash
catabull doctor          # or: npm run doctor
```

Doctor reports:
- Node version, dependencies, Playwright Chromium launch
- Where the workspace root resolved to (env / cwd / home)
- Whether `cv.md` / `config/profile.yml` / `portals.yml` exist
- Pdflatex availability (optional, only for LaTeX CV mode)

Pipeline integrity check:

```bash
npm run verify             # reads data/applications.md
```

## What you get

| Action | Where |
|---|---|
| Land on real role matches | Discover tab, post-onboarding |
| Evaluate an offer | Paste a URL or JD into the chat drawer, runs `/catabull evaluate` |
| Generate a tailored CV + cover letter + Q&A | Tailor button on any Discover/Pipeline card |
| Run a portal scan | Search tab -> Run scan, or `catabull scan` |
| Health-check tracked portals | Search tab -> Health -> Run check |
| Recover an auto-disabled company's URL | Health tab -> Find new URL on the affected row |
| Track the funnel | Pipeline / Analytics tabs |
| Multi-profile archive | Profile tab, switch between target sets (for example design vs engineering) |

For deeper customization, see `docs/guides/CUSTOMIZATION.md`. For the script-by-script reference, see `docs/guides/SCRIPTS.md`.
