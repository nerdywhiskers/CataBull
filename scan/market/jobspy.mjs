/**
 * scan/market/jobspy.mjs — JobSpy sidecar adapter (Level 4 of Deep Scan).
 *
 * Bridges scan/market/jobspy_wrapper.py to the Level-3-shaped pipeline.
 * Returns hits in the same shape as scan/level3.mjs:runLevel3() so the
 * dashboard SSE route can splice JobSpy results into the same dedupe +
 * liveness + writer flow.
 *
 * Two execution paths, in priority order:
 *   1. `uv run --with python-jobspy ...` — preferred; uv handles the venv
 *      transparently and installs jobspy on first call (cached after).
 *   2. `python3` (or `python` on Windows) — fallback; assumes the user
 *      `pip install python-jobspy`'d into the resolved interpreter.
 *
 * If neither resolves, returns `{ available: false }` and the caller skips
 * the JobSpy stage entirely. No crash, no scary message — just a soft skip.
 *
 * Spec: docs/design/MARKET_DISCOVERY.md, adapted to flow through Level 3's
 *       dedupe + liveness pipeline rather than writing data/market.md.
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = join(__dirname, 'jobspy_wrapper.py');

export const DEFAULT_SITES = ['indeed', 'wellfound', 'zip_recruiter', 'google', 'glassdoor'];
const DEFAULT_RESULTS_PER_SITE = 20;
const DEFAULT_HOURS_OLD = 168; // 1 week
const JOBSPY_TIMEOUT_MS = 240_000; // 4 min — scrape_jobs can be slow

/**
 * Detect a Python runner that can execute the wrapper. Cached per-process.
 * Resolves to one of:
 *   { kind: 'uv', cmd: 'uv', args: ['run', '--with', 'python-jobspy', 'python'] }
 *   { kind: 'python', cmd: 'python3' | 'python', args: [] }
 *   { kind: 'none' }
 */
let runnerCache = null;
export async function detectRunner({ which = whichSync } = {}) {
  if (runnerCache) return runnerCache;
  if (which('uv')) {
    runnerCache = { kind: 'uv', cmd: 'uv', args: ['run', '--with', 'python-jobspy', 'python'] };
    return runnerCache;
  }
  const py = which('python3') || which('python');
  if (py) {
    runnerCache = { kind: 'python', cmd: py, args: [] };
    return runnerCache;
  }
  runnerCache = { kind: 'none' };
  return runnerCache;
}

export function resetRunnerCache() { runnerCache = null; }

/**
 * Synchronous PATH lookup using PATHEXT on Windows so `python` matches
 * `python.exe`. Returns the resolved absolute path or null.
 */
function whichSync(cmd) {
  const PATH = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try { if (existsSync(candidate)) return candidate; } catch {}
    }
  }
  return null;
}

/**
 * Run JobSpy.
 *
 * @param {object} opts
 * @param {string} opts.query — search keywords (required)
 * @param {string} [opts.location]
 * @param {boolean} [opts.isRemote]
 * @param {Array<string>} [opts.sites]
 * @param {boolean} [opts.withLinkedin]
 * @param {number} [opts.resultsPerSite]
 * @param {number} [opts.hoursOld]
 * @param {string} [opts.countryIndeed]
 * @param {function} [opts.runner] — injected `{ kind, cmd, args }` for tests
 * @param {function} [opts.spawnImpl] — injected `child_process.spawn` for tests
 * @returns {Promise<{available: boolean, jobs?: Array, sites?: Array, error?: string}>}
 */
export async function runJobSpy(opts = {}) {
  if (!opts.query) {
    return { available: true, jobs: [], error: 'query is required' };
  }

  const runner = opts.runner || await detectRunner();
  if (runner.kind === 'none') {
    return { available: false, jobs: [] };
  }

  if (!existsSync(WRAPPER_PATH)) {
    return { available: false, jobs: [], error: `wrapper not found at ${WRAPPER_PATH}` };
  }

  const cfg = {
    query: opts.query,
    location: opts.location || '',
    is_remote: Boolean(opts.isRemote),
    sites: Array.isArray(opts.sites) && opts.sites.length ? opts.sites : DEFAULT_SITES,
    with_linkedin: Boolean(opts.withLinkedin),
    results_per_site: opts.resultsPerSite || DEFAULT_RESULTS_PER_SITE,
    hours_old: opts.hoursOld || DEFAULT_HOURS_OLD,
    country_indeed: opts.countryIndeed || 'USA',
  };

  const spawner = opts.spawnImpl || spawn;
  const args = [...runner.args, WRAPPER_PATH];
  const env = { ...process.env, PYTHONUNBUFFERED: '1' };

  const stdout = await runWithTimeout(spawner, runner.cmd, args, { env }, cfg, JOBSPY_TIMEOUT_MS);
  if (stdout.error) {
    return { available: true, jobs: [], error: stdout.error };
  }

  let payload;
  try { payload = JSON.parse(stdout.body); }
  catch (err) {
    return { available: true, jobs: [], error: `wrapper returned non-JSON: ${stdout.body.slice(0, 200)}` };
  }

  if (payload.ok === false) {
    return { available: true, jobs: [], error: payload.error || 'unknown wrapper error' };
  }

  return {
    available: true,
    jobs: normalizeJobs(payload.jobs || []),
    sites: payload.sites || cfg.sites,
  };
}

/**
 * Normalize jobspy records into the `{url, title, company, location, postedAt,
 * source, snippet}` shape that level3.mjs uses. Drops rows missing both
 * url and title (almost never happens in practice but defends against
 * jobspy schema drift).
 */
export function normalizeJobs(records) {
  const out = [];
  for (const r of records) {
    const url = r.job_url_direct || r.job_url;
    const title = String(r.title || '').trim();
    if (!url || !title) continue;
    const company = String(r.company || '').trim() || 'Unknown';
    const site = String(r.site || '').toLowerCase() || 'jobspy';
    out.push({
      url,
      title,
      company,
      location: String(r.location || '').trim(),
      postedAt: r.date_posted ? String(r.date_posted).slice(0, 10) : '',
      source: `jobspy:${site}`,
      searchSnippet: typeof r.description === 'string' ? r.description.slice(0, 280) : '',
    });
  }
  return out;
}

function runWithTimeout(spawner, cmd, args, options, stdinJson, timeoutMs) {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let done = false;

    const child = spawner(cmd, args, options);

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ body: '', error: `jobspy wrapper timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    child.stderr.on('data', (c) => { stderrBuf += c.toString(); });

    child.on('error', (err) => {
      if (done) return; done = true;
      clearTimeout(timer);
      resolve({ body: '', error: `failed to spawn ${cmd}: ${err.message}` });
    });

    child.on('close', (code) => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (code !== 0 && !stdoutBuf.trim()) {
        resolve({ body: '', error: `${cmd} exited ${code}: ${stderrBuf.slice(0, 400)}` });
      } else {
        resolve({ body: stdoutBuf });
      }
    });

    try {
      child.stdin.end(JSON.stringify(stdinJson));
    } catch (err) {
      if (done) return; done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve({ body: '', error: `failed to write stdin: ${err.message}` });
    }
  });
}
