# Docs index

Where to look depending on what you need.

## Reading order for someone new

1. [guides/SETUP.md](guides/SETUP.md) - install and first-run setup
2. [design/ARCHITECTURE.md](design/ARCHITECTURE.md) - current system snapshot
3. [guides/CUSTOMIZATION.md](guides/CUSTOMIZATION.md) - profile, portals, and template customization
4. [guides/SCRIPTS.md](guides/SCRIPTS.md) - npm scripts and test commands

## By directory

### [design/](design/) - how the system is built

| Doc | Scope |
|---|---|
| [ARCHITECTURE.md](design/ARCHITECTURE.md) | Full system snapshot: onboarding, evaluation, dashboard, agent layer, and file conventions |
| [WORKSPACE_AND_PROFILES.md](design/WORKSPACE_AND_PROFILES.md) | How workspace and profile data abstractions compose |
| [MARKET_DISCOVERY.md](design/MARKET_DISCOVERY.md) | Deferred JobSpy market discovery notes |

### [guides/](guides/) - user-facing how-to

| Doc | Scope |
|---|---|
| [SETUP.md](guides/SETUP.md) | Global CLI install and source-tree development install |
| [CUSTOMIZATION.md](guides/CUSTOMIZATION.md) | Profile, archetype table, portals, CV template, and hooks |
| [SCRIPTS.md](guides/SCRIPTS.md) | Every npm script and test suite |

## Conventions

- Design docs that describe shipped features should say so near the top.
- User-specific data belongs in the user layer and should stay out of committed system files.
- Keep public docs focused on setup, usage, architecture, and maintenance.
