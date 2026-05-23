# Design Note — Workspace + Profiles

How `lib/workspace.mjs` and `dashboard-web/lib/user-data.mjs` compose.
Originally written 2026-05-08 for the strategy merge; updated after the merge to describe current behavior plus remaining follow-up work.

## TL;DR

These two abstractions answer different questions and don't fight.
- **`workspace.mjs`** answers *where* user data lives.
- **`user-data.mjs`** answers *what counts as* user data, and how to
  archive / restore / switch between named profile sets.

The merge needs ~30 minutes of mechanical work to make `user-data.mjs`
read/write through Workspace methods instead of raw `fs`. After that,
both layers stay distinct and serve their separate purposes.

## What each layer is

### `lib/workspace.mjs`

```
LocalWorkspace(root)
  .read(rel) / .write(rel, content)
  .readYaml / .writeYaml
  .copy(srcRel, destRel)
  .delete(rel)
  .mkdir(rel)
  .list(rel)
  .stat(rel)
  .exists(rel)
  .resolve(rel)            # absolute path, traversal-guarded
  .root                    # absolute root
```

Plus `asWorkspace(rootOrWs)` (string→Workspace coercion at the
boundary of legacy callers) and `defaultWorkspace(fallback)` (env
override).

`lib/workspace-resolver.mjs` adds the *where to put it on first run*
layer: env > cwd-with-markers > project-root (dev only) > `~/.catabull/`.

The Workspace abstraction is the join point for hosted: a future
`S3Workspace` swaps in without touching modes or routes.

### `dashboard-web/lib/user-data.mjs`

```
USER_PATHS = [
  'cv.md', 'config/profile.yml', 'modes/_profile.md',
  'portals.yml', 'article-digest.md',
  'data/applications.md', 'data/pipeline.md',
  'data/scan-history.tsv', 'data/scan-schedule-state.json',
  'data/follow-ups.md', 'data/outreach',
  'reports', 'output/tailor-bundles', 'interview-prep',
]

archiveActiveProfile(root, { id, label })
restoreProfile(root, id)
listProfiles(root)
deleteStoredProfile(root, id)
removeActiveUserData(root)
getActiveProfileId(root) / setActiveProfileId(root, id)
```

Stored in `<root>/.profiles/<id>/` with a `manifest.json` per profile
and a top-level `<root>/.profiles/active.json`.

`output/` is intentionally narrowed to `output/tailor-bundles` so runtime caches such as `output/opencode-xdg-*` are not moved or deleted during profile switching.

## How they compose

A single user has:

```
workspace root  (where the active user data lives — picked by resolver)
├── cv.md, portals.yml, …               ← USER_PATHS (the active profile)
└── .profiles/                           ← multi-profile store
    ├── active.json                      ← which profile id is active
    ├── designer/
    │   ├── manifest.json
    │   └── (full mirror of USER_PATHS for this profile)
    └── engineer/
        ├── manifest.json
        └── (full mirror of USER_PATHS for this profile)
```

Operations:
- **`archiveActiveProfile`** — copies the active USER_PATHS into
  `.profiles/<id>/`, updates `active.json`. After this, you can
  modify the active CV freely; the archived copy is frozen.
- **`restoreProfile(id)`** — wipes the active USER_PATHS, copies
  `.profiles/<id>/` back over the active layer. The previously
  active state is gone unless it was archived first.
- **`removeActiveUserData`** — unlinks the active layer. Used by
  the "start over" flow in onboarding.

The Workspace abstraction is the *substrate* — every read, write,
copy, delete, mkdir in user-data.mjs ought to go through Workspace
methods. Today it uses `fs` directly. That's the merge work.

## Remaining follow-up

`user-data.mjs` still uses filesystem helpers directly. That works for the local dashboard, but hosted storage should route these operations through `Workspace` methods before an S3-backed workspace lands.

### 1. user-data.mjs migration

Internally route every `fs` call through `asWorkspace(root)`:

```js
// before
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
const path = join(root, rel);
if (existsSync(path)) rmSync(path, { recursive: true, force: true });

// after
import { asWorkspace } from '../../lib/workspace.mjs';
const ws = asWorkspace(root);
if (ws.exists(rel)) ws.delete(rel);   // (delete on Workspace would need .delete to handle dirs — see below)
```

Two specific changes the Workspace API needs to absorb to make this
clean:

- **`delete()` already handles files and directories.** Keep that behavior; profile archives contain dir entries (`reports`, `output/tailor-bundles`, `interview-prep`, `data/outreach`).
- **`copy()` still needs recursive directory support** if `user-data.mjs` migrates fully to Workspace methods. Today profile switching uses `cpSync` directly, so local profile switching works.

This needs recursive copy support in `lib/workspace.mjs` plus coverage in profile-switch tests.

### 2. profilesRoot vs ARCHIVE convention

`user-data.mjs` puts archives at `<root>/.profiles/`. That's fine on
Local. On Hosted (S3), the natural path is also `s3://bucket/{tenant}/.profiles/`.
The `Workspace` abstraction means user-data.mjs doesn't need to know.

Just make sure `.profiles/` is **never** in `USER_PATHS` (it's not —
verified) and **always** in the workspace's gitignore-equivalent so
the archive of a profile never re-archives recursively.

### 3. Health and market data paths

`USER_PATHS` includes `data/scan-schedule-state.json`, `data/scan-health.json`, and `data/scan-health.log`, so profile archive/restore preserves scanner health state with the rest of scan state. Market discovery is deferred W6, so `data/market.md` and `data/market-cache.json` stay out of `USER_PATHS` until that feature lands.

### 4. CATABULL_WORKSPACE_ROOT awareness

`profilesRoot(root)` joins `.profiles` to whatever `root` it's given.
After PR 1.8, the dashboard server resolves its workspace via
`ensureWorkspace()`, so the route layer naturally hands the resolved
root to `archiveActiveProfile`/`restoreProfile`. No change needed —
just confirm in a smoke test that `CATABULL_WORKSPACE_ROOT=/tmp/foo
catabull` produces archives at `/tmp/foo/.profiles/`, not the
package install dir.

## Forward compatibility — Phase 2 hosted

When we go hosted (Phase 2), the picture stays clean:

| Concept | Local | Hosted |
|---|---|---|
| Workspace root | filesystem path | S3 prefix `s3://bucket/{tenant}/` |
| `Workspace.read/write` | `fs.readFileSync` / `fs.writeFileSync` | `s3.getObject` / `s3.putObject` |
| `USER_PATHS` | unchanged | unchanged (same list, different backing) |
| `archiveActiveProfile` | Workspace recursive copy | S3 server-side copy with prefix rewrite |
| `restoreProfile` | Workspace delete + recursive copy | delete-prefix + s3 copy |
| Profile isolation between users | n/a (one user per laptop) | tenant-scoped — cross-tenant access impossible because the Workspace's S3 prefix already enforces it |

The `Workspace` interface is the *only* layer that needs different
implementations. `user-data.mjs` is reusable verbatim because every
operation goes through Workspace methods.

This is the architectural payoff for doing PR 0.1 (Workspace
abstraction) before any of the user-visible PRs landed: the layer
above (user-data.mjs) doesn't have to know about the storage
backend.

## What we're explicitly NOT doing

- **Pulling `USER_PATHS` out of `dashboard-web/lib/`.** It feels
  shared, but only the dashboard uses it today (the CLI scripts
  don't archive/restore profiles). If a CLI command later needs it,
  move it to `lib/user-paths.mjs` then. Premature otherwise.
- **Removing `dashboard-web/lib/writers.mjs`'s `readProfile`/`readPortals`
  helpers.** They're used widely. They already accept `root` strings
  and internally route through Workspace (per PR 0.1). No change
  needed.
- **Profile-aware multi-tenancy on Local.** A laptop user has one
  active profile at a time; the archive store is just for switching
  between e.g. "design" and "engineering" target sets. We are not
  building multi-user-on-one-machine support here.

## Open questions

1. **Should `restoreProfile` archive the current active state first?**
   Today it doesn't — it overwrites. The dashboard could prompt
   ("save current first?"); user-data.mjs could expose a
   `switchProfile(root, fromId, toId)` convenience that combines
   archive + restore. Worth a small UX call before the merge.
2. **Profile rename.** Not exposed today. Easy add: rename the
   `.profiles/<id>/` directory and update the manifest's id +
   updated_at. Worth a follow-up PR.
3. **Profile size guardrails.** Multi-profile means the workspace
   can quietly grow N× the size of one profile. Not a problem on
   disk; could be a problem on Hosted Pro storage quotas. Track
   per-profile size in the manifest so we can warn before the user
   hits the cap.

## Follow-up checklist

- [x] Migrate `user-data.mjs` to use Workspace methods.
- [x] Add recursive copy support to `lib/workspace.mjs` if profile archive/restore moves to Workspace.
- [x] Decide whether `scan-health` and future market discovery files are profile-specific or workspace-global.
- [x] Smoke test: `archiveActiveProfile` + `restoreProfile` with scan-health state covered by `tests/test-profiles.mjs`.
