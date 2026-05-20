/**
 * lib/workspace-resolver.mjs — Pick + scaffold the user's CareerBot workspace.
 *
 * When a globally installed `careerbot` CLI starts, the runtime needs to
 * decide which directory holds the user's data (cv.md, profile.yml,
 * portals.yml, applications.md, output/, reports/, …). Three candidates,
 * resolved in order:
 *
 *   1. CAREERBOT_WORKSPACE_ROOT env var — explicit override always wins
 *   2. process.cwd() — if the current directory looks like a CareerBot
 *      workspace (any of cv.md / portals.yml / config/profile.yml present)
 *   3. ~/.careerbot/ — created on first run if neither of the above fits
 *
 * Mode (3) is the fresh-install path: a globally installed CLI run from
 * a random directory shouldn't pollute that directory; it should land in
 * a stable per-user home.
 *
 * This module is pure path resolution + scaffolding; no Fastify, no agent
 * runner, no scan logic. The dashboard server and CLI scripts both call
 * resolveWorkspaceRoot() at startup.
 */

import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

/** Files whose presence in a directory marks it as an existing workspace. */
const WORKSPACE_MARKERS = [
  'cv.md',
  'portals.yml',
  'config/profile.yml',
  'data/applications.md',
];

const HOME_WORKSPACE_DIR = '.careerbot';

export const RESOLUTION_REASONS = ['env', 'cwd', 'home', 'project'];

/**
 * Returns true if the directory has at least one CareerBot marker file.
 *
 * Used to distinguish "user is running careerbot from inside their data
 * directory" from "user just typed careerbot from /tmp."
 */
export function looksLikeWorkspace(dir) {
  if (!dir || typeof dir !== 'string') return false;
  return WORKSPACE_MARKERS.some((m) => existsSync(join(dir, m)));
}

/**
 * Resolve the workspace root.
 *
 * Returns: { root, reason, created }
 *   root    — absolute path
 *   reason  — 'env' | 'cwd' | 'home' | 'project'
 *   created — true iff this call mkdir-ed the home directory because it
 *             didn't exist (only possible when reason === 'home')
 *
 * `opts.cwd` and `opts.home` are injectable for tests; both default to
 * the real process / OS.
 *
 * `opts.allowProjectFallback` — when true, if no explicit env var is set
 * and the cwd doesn't look like a workspace, use the supplied project
 * root (the source-tree where the package files live) instead of the
 * home dir. The dashboard server uses this for development; the CLI
 * shim does NOT pass it, because globally installed users should never
 * have their data leak into the npm install location.
 */
export function resolveWorkspaceRoot(opts = {}) {
  const {
    env = process.env,
    cwd = process.cwd(),
    home = homedir(),
    projectRoot = null,
    allowProjectFallback = false,
    autoCreate = true,
  } = opts;

  const envRoot = env.CAREERBOT_WORKSPACE_ROOT;
  if (envRoot && envRoot.trim()) {
    return { root: resolve(envRoot.trim()), reason: 'env', created: false };
  }

  if (looksLikeWorkspace(cwd)) {
    return { root: resolve(cwd), reason: 'cwd', created: false };
  }

  if (allowProjectFallback && projectRoot && looksLikeWorkspace(projectRoot)) {
    return { root: resolve(projectRoot), reason: 'project', created: false };
  }

  // Fresh-install path. Land the user in ~/.careerbot/, creating the
  // directory on first run.
  const homeWorkspace = join(home, HOME_WORKSPACE_DIR);
  let created = false;
  if (autoCreate && !existsSync(homeWorkspace)) {
    mkdirSync(homeWorkspace, { recursive: true });
    created = true;
  }
  return { root: resolve(homeWorkspace), reason: 'home', created };
}

/**
 * Default templates copied into a fresh workspace on first run. Each
 * entry is { from, to } — relative paths inside the package (source) and
 * inside the new workspace (dest).
 *
 * We deliberately don't copy `cv.md` or `config/profile.yml` —
 * onboarding handles those interactively.
 */
const DEFAULT_TEMPLATES = [
  { from: 'templates/portals.example.yml', to: 'portals.yml.example' },
  { from: 'config/profile.example.yml', to: 'config/profile.example.yml' },
  { from: 'modes/_profile.template.md', to: 'modes/_profile.template.md' },
  { from: 'templates/states.yml', to: 'templates/states.yml' },
];

/**
 * Scaffold a fresh workspace by copying example templates from the
 * package install location. Idempotent — only copies files that don't
 * already exist at the destination.
 *
 * Returns: { copied: [destPaths], skipped: [destPaths] }
 */
export function scaffoldWorkspace(packageRoot, workspaceRoot, { templates = DEFAULT_TEMPLATES } = {}) {
  const copied = [];
  const skipped = [];

  for (const { from, to } of templates) {
    const src = join(packageRoot, from);
    const dest = join(workspaceRoot, to);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) {
      skipped.push(to);
      continue;
    }
    const destDir = join(dest, '..');
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    copyFileSync(src, dest);
    copied.push(to);
  }

  return { copied, skipped };
}

/**
 * Compose resolveWorkspaceRoot + scaffoldWorkspace for the global-CLI
 * entry point. Returns the same shape as resolveWorkspaceRoot, plus
 * `scaffold` listing what was copied (only populated when `created`).
 */
export function ensureWorkspace(opts = {}) {
  const { packageRoot, ...resolverOpts } = opts;
  const resolution = resolveWorkspaceRoot(resolverOpts);
  let scaffold = null;
  if (resolution.created && packageRoot) {
    scaffold = scaffoldWorkspace(packageRoot, resolution.root);
  }
  return { ...resolution, scaffold };
}
