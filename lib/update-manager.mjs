import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DEFAULT_REMOTE = 'origin';
const DEFAULT_BRANCH = 'main';
const DEFAULT_REPO = 'your-github-user/catabull';
const GIT_TIMEOUT_MS = 45_000;
const NPM_TIMEOUT_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;

export async function getUpdateStatus(packageRoot, opts = {}) {
  const root = String(packageRoot || '');
  const localVersion = readPackageVersion(root);
  const installKind = normalizeInstallKindOverride(opts.installKind) || detectInstallKind(root);
  const repo = opts.repo || readPackageRepo(root) || DEFAULT_REPO;

  if (installKind === 'unsupported') {
    return {
      supported: false,
      installKind,
      localVersion,
      updateAvailable: false,
      canUpdate: false,
      canGitPull: false,
      status: 'unsupported',
      message: 'CataBull install path not recognized. Reinstall via the official one-line installer to enable in-app updates.',
    };
  }

  // Remote version from GitHub raw — works regardless of install kind. If the
  // network is unavailable we surface that without claiming "up to date".
  let remoteVersion = '';
  let remoteFetchError = '';
  try {
    remoteVersion = await fetchRemoteVersion(repo, opts);
  } catch (err) {
    remoteFetchError = err.message || String(err);
  }

  if (installKind === 'npm-global') {
    const updateAvailable = Boolean(remoteVersion && localVersion && compareVersions(remoteVersion, localVersion) > 0);
    return {
      supported: true,
      installKind,
      status: remoteFetchError ? 'check-failed' : (updateAvailable ? 'available' : 'current'),
      localVersion,
      remoteVersion,
      updateAvailable,
      canUpdate: updateAvailable,
      canGitPull: false,
      // Frontend pre-2026-05 read these for a commit-pair display; keep them
      // present (empty for npm-global) so old clients don't crash.
      localCommit: '',
      remoteCommit: '',
      dirty: false,
      branch: '',
      message: remoteFetchError
        ? `Could not check GitHub: ${remoteFetchError}`
        : updateAvailable
          ? `Update available: ${localVersion} → ${remoteVersion}.`
          : 'CataBull is up to date.',
    };
  }

  // git-checkout — gather both commit-diff and version-diff so the UI can
  // decide between Update (npm) and Git Pull intelligently.
  const remote = opts.remote || DEFAULT_REMOTE;
  const branch = opts.branch || DEFAULT_BRANCH;
  const gitInfo = await inspectGitRepo(root);
  const dirty = await isGitDirty(root).catch(() => false);
  const remoteRef = `${remote}/${branch}`;
  const [localCommit, remoteCommit] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']).then(r => clean(r.stdout)).catch(() => ''),
    git(root, ['rev-parse', '--verify', remoteRef]).then(r => clean(r.stdout)).catch(() => ''),
  ]);
  const commitsDiffer = Boolean(localCommit && remoteCommit && localCommit !== remoteCommit);
  const versionUpdate = Boolean(remoteVersion && localVersion && compareVersions(remoteVersion, localVersion) > 0);
  const updateAvailable = commitsDiffer || versionUpdate;
  const onTargetBranch = gitInfo.branch === branch;

  return {
    supported: true,
    installKind,
    status: remoteFetchError && !commitsDiffer ? 'check-failed' : (updateAvailable ? 'available' : 'current'),
    localVersion,
    remoteVersion,
    branch: gitInfo.branch,
    remote,
    dirty,
    localCommit: shortSha(localCommit),
    remoteCommit: shortSha(remoteCommit),
    updateAvailable,
    canUpdate: updateAvailable,
    canGitPull: commitsDiffer && !dirty && onTargetBranch,
    message: buildGitMessage({ updateAvailable, dirty, onTargetBranch, currentBranch: gitInfo.branch, targetBranch: branch, remoteFetchError, localVersion, remoteVersion }),
  };
}

export async function checkForUpdates(packageRoot, opts = {}) {
  const root = String(packageRoot || '');
  const installKind = detectInstallKind(root);
  // For git-checkouts, refresh tracking refs before reading commit deltas so
  // the user gets accurate "available" state without leaving the dashboard.
  if (installKind === 'git-checkout') {
    const remote = opts.remote || DEFAULT_REMOTE;
    const branch = opts.branch || DEFAULT_BRANCH;
    try {
      await git(root, ['fetch', remote, branch, '--prune'], { timeoutMs: opts.timeoutMs || GIT_TIMEOUT_MS });
    } catch {
      // Best-effort: if fetch fails (no network, no upstream), getUpdateStatus
      // will still return the local view and any raw-GitHub version delta.
    }
  }
  return getUpdateStatus(root, opts);
}

export async function applyUpdate(packageRoot, opts = {}) {
  const root = String(packageRoot || '');
  const installKind = detectInstallKind(root);
  const repo = opts.repo || readPackageRepo(root) || DEFAULT_REPO;

  if (installKind === 'unsupported') {
    return {
      success: false,
      installKind,
      status: 'unsupported',
      message: 'In-app updates require an official npm or git install.',
    };
  }

  const before = await getUpdateStatus(root, opts);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    await execFileAsync(npmCmd, ['install', '-g', `github:${repo}`], {
      timeout: opts.timeoutMs || NPM_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (err) {
    const detail = clean(err.stderr || err.stdout || err.message || String(err));
    return {
      success: false,
      installKind,
      status: 'failed',
      message: detail ? `npm install failed: ${detail}` : 'npm install failed.',
    };
  }

  const after = await getUpdateStatus(root, opts);
  return {
    success: true,
    installKind,
    status: 'updated',
    before,
    after,
    changed: before.localVersion !== after.localVersion || before.localCommit !== after.localCommit,
    needsRestart: true,
    message: 'CataBull updated via npm. Restart the dashboard to use the new version.',
  };
}

export async function applyGitPull(packageRoot, opts = {}) {
  const root = String(packageRoot || '');
  const installKind = detectInstallKind(root);
  if (installKind !== 'git-checkout') {
    return {
      success: false,
      installKind,
      status: 'unsupported',
      message: 'Git Pull only works for installs that have a .git directory.',
    };
  }

  const remote = opts.remote || DEFAULT_REMOTE;
  const branch = opts.branch || DEFAULT_BRANCH;
  const repo = await inspectGitRepo(root);
  if (repo.branch !== branch) {
    return {
      success: false,
      installKind,
      status: 'blocked',
      message: `Refusing to pull while on branch ${repo.branch}. Switch to ${branch} first.`,
    };
  }
  if (await isGitDirty(root)) {
    return {
      success: false,
      installKind,
      status: 'blocked',
      message: 'Refusing to pull with local uncommitted changes. Commit or stash them first.',
    };
  }

  const before = await getUpdateStatus(root, { ...opts, remote, branch });
  try {
    await git(root, ['fetch', remote, branch, '--prune'], { timeoutMs: opts.timeoutMs || GIT_TIMEOUT_MS });
    await git(root, ['pull', '--ff-only', remote, branch], { timeoutMs: opts.timeoutMs || GIT_TIMEOUT_MS });
  } catch (err) {
    return {
      success: false,
      installKind,
      status: 'failed',
      message: err.message || 'git pull failed.',
    };
  }
  const after = await getUpdateStatus(root, { ...opts, remote, branch });

  return {
    success: true,
    installKind,
    status: 'updated',
    before,
    after,
    changed: before.localCommit !== after.localCommit,
    needsRestart: true,
    message: before.localCommit === after.localCommit
      ? 'Already up to date.'
      : 'CataBull updated via git pull. Restart the dashboard to use the new version.',
  };
}

export function detectInstallKind(packageRoot) {
  const root = String(packageRoot || '');
  if (!root || !existsSync(join(root, 'package.json'))) return 'unsupported';
  if (existsSync(join(root, '.git'))) return 'git-checkout';
  // npm-global layout: <prefix>/lib/node_modules/catabull on POSIX,
  // <prefix>\node_modules\catabull on Windows. The basename is the package
  // name and the parent directory is node_modules.
  const parent = basename(dirname(root)).toLowerCase();
  const self = basename(root).toLowerCase();
  if (parent === 'node_modules' && self === 'catabull') return 'npm-global';
  return 'unsupported';
}

async function fetchRemoteVersion(repo, opts = {}) {
  const branch = opts.branch || DEFAULT_BRANCH;
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/package.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.httpTimeoutMs || HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return String(json.version || '').trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectGitRepo(root) {
  if (!existsSync(join(root, '.git'))) return { branch: '', top: '' };
  try {
    const branch = clean((await git(root, ['branch', '--show-current'])).stdout) || 'HEAD';
    const top = clean((await git(root, ['rev-parse', '--show-toplevel'])).stdout);
    return { branch, top };
  } catch {
    return { branch: '', top: '' };
  }
}

async function isGitDirty(root) {
  const { stdout } = await git(root, ['status', '--porcelain']);
  return clean(stdout).length > 0;
}

async function git(cwd, args, opts = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      timeout: opts.timeoutMs || GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const detail = clean(err.stderr || err.stdout || err.message || String(err));
    throw new Error(detail || `git ${args.join(' ')} failed`);
  }
}

function buildGitMessage({ updateAvailable, dirty, onTargetBranch, currentBranch, targetBranch, remoteFetchError, localVersion, remoteVersion }) {
  if (!updateAvailable) {
    if (remoteFetchError) return `Could not check GitHub: ${remoteFetchError}`;
    return 'CataBull is up to date.';
  }
  const versionNote = (localVersion && remoteVersion && localVersion !== remoteVersion)
    ? `${localVersion} → ${remoteVersion}`
    : 'new commits available';
  if (!onTargetBranch) return `Update available (${versionNote}), but you're on branch ${currentBranch || 'detached'}. Switch to ${targetBranch || 'main'} or use npm Update.`;
  if (dirty) return `Update available (${versionNote}). Local uncommitted changes block Git Pull — commit or stash, then retry. npm Update is unaffected.`;
  return `Update available: ${versionNote}.`;
}

function normalizeInstallKindOverride(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'npm-global' || normalized === 'git-checkout') return normalized;
  return '';
}

function readPackageVersion(root) {
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return json.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Pull "<owner>/<repo>" out of the npm `repository` field. Handles the
// common shapes:
//   - object  { url: "git+https://github.com/<o>/<r>.git" }
//   - object  { url: "git@github.com:<o>/<r>.git" }
//   - object  { url: "github:<o>/<r>" }
//   - string  "github:<o>/<r>" or any of the URL forms above
// Returns null if no GitHub repo can be derived; the caller falls back
// to DEFAULT_REPO so upstream/template installs still behave the same.
function readPackageRepo(root) {
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const raw = typeof json.repository === 'string' ? json.repository : json.repository?.url;
    if (!raw) return null;
    const match = String(raw).match(/github(?:\.com)?[/:]([^/]+)\/([^/.#?]+?)(?:\.git)?(?:[#?].*)?$/i);
    if (!match) return null;
    return `${match[1]}/${match[2]}`;
  } catch {
    return null;
  }
}

function clean(value) {
  return String(value || '').trim();
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '';
}

// Semver-lite compare: only major.minor.patch numerics. Pre-release tags
// are ignored — CataBull ships plain x.y.z so this is sufficient. Returns
// 1 if a > b, -1 if a < b, 0 if equal.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
