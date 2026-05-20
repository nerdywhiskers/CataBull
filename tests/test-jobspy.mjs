#!/usr/bin/env node

/**
 * test-jobspy.mjs — Unit tests for scan/market/jobspy.mjs.
 *
 * No Python, no network — all subprocesses are mocked via an injected
 * `spawnImpl`. Covers runner detection, payload normalization, and the
 * error paths the Deep Scan SSE route depends on.
 */

import { EventEmitter } from 'events';
import { runJobSpy, normalizeJobs, detectRunner, resetRunnerCache } from '../scan/market/jobspy.mjs';

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { passed++; }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

// ── Fake spawn helper ──────────────────────────────────────────────
//
// Returns a spawn-shaped factory so we can drive stdout/stderr/exit in
// tests without touching child_process.

function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, throwOnStart = false } = {}) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end: (_data) => {},
    };
    child.kill = () => {};
    if (throwOnStart) {
      setImmediate(() => child.emit('error', new Error('ENOENT')));
      return child;
    }
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
}

console.log('\nscan/market/jobspy.mjs');

// ── 1. normalizeJobs ───────────────────────────────────────────────

console.log('\n1. normalizeJobs');

const sample = [
  { title: 'Senior Engineer', company: 'Acme', job_url_direct: 'https://acme.com/job/1', site: 'indeed', location: 'NYC', date_posted: '2026-05-10' },
  { title: 'Lead Designer', company: 'Beta', job_url: 'https://beta.com/job/2', site: 'wellfound', location: 'Remote' },
  { title: '', company: 'Bad', job_url: 'https://x.com/3', site: 'indeed' },     // empty title → drop
  { title: 'Has No URL', company: 'Bad', job_url: '', site: 'indeed' },          // empty url → drop
];

const norm = normalizeJobs(sample);
assert(norm.length === 2, 'drops rows missing url or title');
assert(norm[0].source === 'jobspy:indeed', 'source prefixed with jobspy:<site>');
assert(norm[0].url === 'https://acme.com/job/1', 'prefers job_url_direct over job_url');
assert(norm[0].postedAt === '2026-05-10', 'postedAt sliced to YYYY-MM-DD');
assert(norm[1].url === 'https://beta.com/job/2', 'falls back to job_url when direct is absent');
assert(norm[1].source === 'jobspy:wellfound', 'wellfound source tagged');
assert(norm[1].company === 'Beta', 'company preserved');

// missing company → 'Unknown' (matches level3 convention)
const norm2 = normalizeJobs([{ title: 'X', company: '', job_url: 'https://x.com', site: 'indeed' }]);
assert(norm2[0].company === 'Unknown', 'missing company → Unknown');

// ── 2. runner detection — uv preferred ─────────────────────────────

console.log('\n2. detectRunner');

resetRunnerCache();
let uvRunner = await detectRunner({ which: (cmd) => cmd === 'uv' ? '/fake/bin/uv' : null });
assert(uvRunner.kind === 'uv', 'uv detected when on PATH');
assert(uvRunner.args[0] === 'run' && uvRunner.args.includes('--with'), 'uv args include `run --with`');

resetRunnerCache();
let pyRunner = await detectRunner({ which: (cmd) => cmd === 'python3' ? '/usr/bin/python3' : null });
assert(pyRunner.kind === 'python', 'python3 fallback used when uv missing');
assert(pyRunner.cmd === '/usr/bin/python3', 'python3 path captured');

resetRunnerCache();
let noneRunner = await detectRunner({ which: () => null });
assert(noneRunner.kind === 'none', 'no runner reported when neither tool found');

resetRunnerCache();

// ── 3. runJobSpy — happy path ──────────────────────────────────────

console.log('\n3. runJobSpy happy path');

const stubRunner = { kind: 'uv', cmd: 'uv', args: ['run'] };
const payload = JSON.stringify({
  ok: true,
  jobs: [
    { title: 'Staff Engineer', company: 'Acme', job_url: 'https://acme.com/1', site: 'indeed' },
  ],
  count: 1,
  sites: ['indeed', 'wellfound'],
});

const okResult = await runJobSpy({
  query: 'staff engineer',
  runner: stubRunner,
  spawnImpl: fakeSpawn({ stdout: payload }),
});
assert(okResult.available === true, 'available true when runner present');
assert(okResult.jobs.length === 1, 'one normalized job returned');
assert(okResult.jobs[0].source === 'jobspy:indeed', 'normalized source tag');
assert(Array.isArray(okResult.sites), 'sites array surfaced');

// ── 4. runJobSpy — missing runner returns soft skip ────────────────

console.log('\n4. soft skip when no runner');

const noneResult = await runJobSpy({
  query: 'staff engineer',
  runner: { kind: 'none' },
});
assert(noneResult.available === false, 'available=false when runner kind=none');
assert(noneResult.jobs.length === 0, 'no jobs returned');
assert(!noneResult.error, 'soft skip carries no error');

// ── 5. runJobSpy — required-query validation ──────────────────────

console.log('\n5. missing query');

const noQuery = await runJobSpy({ runner: stubRunner });
assert(noQuery.error?.includes('query'), 'missing query surfaces error');
assert(noQuery.jobs.length === 0, 'no jobs returned for missing query');

// ── 6. runJobSpy — wrapper error envelope ─────────────────────────

console.log('\n6. wrapper error envelope');

const errPayload = JSON.stringify({ ok: false, error: 'python-jobspy not installed' });
const errResult = await runJobSpy({
  query: 'x',
  runner: stubRunner,
  spawnImpl: fakeSpawn({ stdout: errPayload }),
});
assert(errResult.available === true, 'available=true even when wrapper errors (runtime found)');
assert(errResult.error?.includes('python-jobspy not installed'), 'wrapper error surfaced verbatim');
assert(errResult.jobs.length === 0, 'no jobs returned for wrapper error');

// ── 7. runJobSpy — non-JSON wrapper output ─────────────────────────

console.log('\n7. non-JSON stdout');

const garbageResult = await runJobSpy({
  query: 'x',
  runner: stubRunner,
  spawnImpl: fakeSpawn({ stdout: 'Traceback (most recent call last): ...\n' }),
});
assert(garbageResult.error?.includes('non-JSON'), 'non-JSON output surfaces parse error');

// ── 8. runJobSpy — spawn failure (ENOENT) ─────────────────────────

console.log('\n8. spawn ENOENT');

const enoentResult = await runJobSpy({
  query: 'x',
  runner: stubRunner,
  spawnImpl: fakeSpawn({ throwOnStart: true }),
});
assert(enoentResult.error?.includes('failed to spawn') || enoentResult.error?.includes('ENOENT'), 'spawn error surfaced');

// ── 9. runJobSpy — non-zero exit with stderr ──────────────────────

console.log('\n9. non-zero exit');

const failResult = await runJobSpy({
  query: 'x',
  runner: stubRunner,
  spawnImpl: fakeSpawn({ stdout: '', stderr: 'fatal: something broke\n', exitCode: 1 }),
});
assert(failResult.error?.includes('exited 1'), 'non-zero exit surfaced');
assert(failResult.error?.includes('fatal'), 'stderr text included in error');

// ── DONE ──────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
