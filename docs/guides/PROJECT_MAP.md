# Project Map

CareerBot keeps a small compatibility layer in the repo root, then moves most implementation code into focused folders.

## Root

The root stays reserved for project identity, launchers, user-layer files, and compatibility wrappers.

| Path | Purpose |
|---|---|
| `package.json`, `package-lock.json`, `VERSION`, `LICENSE` | Package and release metadata |
| `README.md`, `AGENTS.md`, `CLAUDE.md`, `DATA_CONTRACT.md` | Project instructions and contracts |
| `cv.md`, `portals.yml`, `config/`, `data/`, `reports/`, `output/` | User workspace files in source-checkout mode |
| `start.bat`, `start.command`, `doctor.command` | OS launchers |
| `*.mjs` wrappers | Backward-compatible shims for user-facing commands like `node scan.mjs` |

The wrapper files should stay tiny. They exist so existing docs, scripts, and user muscle memory keep working while the real code lives elsewhere. Test entrypoints live directly in `tests/`.

## Implementation Folders

| Folder | Purpose |
|---|---|
| `scripts/` | Operational CLI implementations: scan, doctor, PDF generation, tracker maintenance, analytics |
| `tests/` | Test suite implementations |
| `lib/` | Shared Node modules used by scripts, routes, scanner, and tests |
| `scan/` | ATS providers, deep scan helpers, health checks, and web search providers |
| `dashboard-web/` | Fastify server, API routes, and vanilla JS dashboard |
| `modes/` | Agent task playbooks |
| `templates/` | Resume and state templates |
| `docs/` | Architecture, setup, design, and strategy notes |
| `marketing/` (on the `marketing` branch) | Static marketing site and install scripts published through GitHub Pages; kept off `main` |

## Compatibility Rule

When moving a root command, keep the old root filename as a wrapper:

```js
#!/usr/bin/env node
import './scripts/scan.mjs';
```

Then make sure the moved implementation resolves repo paths from one directory up:

```js
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
```

This keeps commands such as `node scan.mjs`, `npm run scan`, `careerbot scan`, dashboard subprocess calls, and existing docs working.

## Verification

After layout changes, run:

```bash
node --check scripts/scan.mjs
node scan.mjs --dry-run --limit 1
npm run test:unit
npm run verify
git diff --check
```
