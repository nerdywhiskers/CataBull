#!/usr/bin/env node

/**
 * test-workspace.mjs — Unit tests for lib/workspace.mjs
 *
 * Pure-logic + temp-dir tests. Creates a fresh temp directory per run,
 * exercises every method, and cleans up. No mocks — the LocalWorkspace
 * is thin enough that real fs is the right scope.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { LocalWorkspace, asWorkspace, atomicWriteFileSync, defaultWorkspace } from '../lib/workspace.mjs';

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

function assertThrows(fn, expectedSubstring, msg) {
  total++;
  try {
    fn();
    failed++;
    console.log(`  ❌ ${msg} (expected to throw, did not)`);
  } catch (err) {
    if (expectedSubstring && !err.message.includes(expectedSubstring)) {
      failed++;
      console.log(`  ❌ ${msg} (threw, but message lacked "${expectedSubstring}": ${err.message})`);
    } else {
      passed++;
      if (VERBOSE) console.log(`  ✅ ${msg}`);
    }
  }
}

console.log('\nlib/workspace.mjs');

// Each section creates its own scratch dir to keep tests independent.
function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'catabull-ws-test-'));
  const ws = new LocalWorkspace(dir);
  try {
    fn(ws, dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── 1. CONSTRUCTOR & RESOLVE ──────────────────────────────────────────

console.log('\n1. Constructor + path resolution');

assertThrows(() => new LocalWorkspace(), 'requires a root', 'rejects empty constructor');
assertThrows(() => new LocalWorkspace(''), 'requires a root', 'rejects empty string root');

withTempWorkspace((ws, dir) => {
  assert(ws.root.endsWith(dir.split(sep).pop()), 'stores absolute root');
  assert(ws.resolve('cv.md').endsWith('cv.md'), 'resolve() returns path ending in relPath');
  assert(ws.resolve('data/applications.md').includes('applications.md'), 'resolve() handles nested paths');
  assert(ws.resolve('data\\applications.md').includes('applications.md'), 'resolve() normalizes backslashes');
  assert(ws.resolve('/cv.md').endsWith('cv.md'), 'resolve() strips leading slash');
  assert(ws.resolve('./cv.md').endsWith('cv.md'), 'resolve() handles ./ prefix');

  assertThrows(() => ws.resolve(''), 'non-empty', 'resolve() rejects empty path');
  assertThrows(() => ws.resolve(null), 'non-empty', 'resolve() rejects null path');
  assertThrows(() => ws.resolve('../escape.txt'), 'Path escape', 'resolve() rejects path traversal');
  assertThrows(() => ws.resolve('foo/../../escape.txt'), 'Path escape', 'resolve() rejects traversal via subdir');
});

// ── 2. READ / WRITE / EXISTS ──────────────────────────────────────────

console.log('\n2. read / write / exists');

withTempWorkspace((ws) => {
  assert(ws.exists('cv.md') === false, 'fresh workspace has no cv.md');
  assert(ws.read('cv.md') === null, 'read() of missing file returns null');

  ws.write('cv.md', '# Jane Doe\n\nSenior engineer.');
  assert(ws.exists('cv.md'), 'cv.md exists after write');
  assert(ws.read('cv.md').includes('Jane Doe'), 'read() round-trips content');

  // Auto-mkdir on write to nested path
  ws.write('data/pipeline.md', '# Pipeline');
  assert(ws.exists('data/pipeline.md'), 'write() auto-creates parent directories');
  assert(ws.read('data/pipeline.md') === '# Pipeline', 'nested read works');

  // Overwrite
  ws.write('cv.md', 'updated');
  assert(ws.read('cv.md') === 'updated', 'write() overwrites existing file');
  assert(readdirSync(ws.root).every((name) => !name.includes('.catabull-tmp-')), 'successful write leaves no temporary files');
});

withTempWorkspace((ws) => {
  const target = ws.resolve('cv.md');
  writeFileSync(target, 'original');
  assertThrows(() => atomicWriteFileSync(target, 'replacement', {
    writeFile: writeFileSync,
    renameFile: () => { throw new Error('simulated rename failure'); },
    removeFile: unlinkSync,
  }), 'simulated rename failure', 'atomic helper surfaces rename failures');
  assert(readFileSync(target, 'utf8') === 'original', 'failed atomic replacement preserves original file');
  assert(readdirSync(ws.root).every((name) => !name.includes('.catabull-tmp-')), 'failed atomic replacement cleans temporary file');
});

// ── 3. YAML HELPERS ───────────────────────────────────────────────────

console.log('\n3. readYaml / writeYaml');

withTempWorkspace((ws) => {
  assert(ws.readYaml('config/profile.yml') === null, 'readYaml of missing returns null');

  ws.writeYaml('config/profile.yml', {
    candidate: { name: 'Jane', email: 'jane@example.com' },
    target_roles: { primary: ['SRE', 'Platform Eng'] },
  });
  assert(ws.exists('config/profile.yml'), 'writeYaml creates file');

  const parsed = ws.readYaml('config/profile.yml');
  assert(parsed.candidate.name === 'Jane', 'readYaml returns parsed object');
  assert(parsed.target_roles.primary[0] === 'SRE', 'nested arrays preserved');

  // Malformed YAML returns null
  ws.write('bad.yml', 'not: valid: yaml: here:');
  let captured = null;
  const result = ws.readYaml('bad.yml', { onError: (e) => { captured = e; } });
  assert(result === null, 'readYaml returns null on parse error');
  assert(captured !== null, 'onError callback fires on parse error');
});

// ── 4. COPY / DELETE / MKDIR ──────────────────────────────────────────

console.log('\n4. copy / delete / mkdir');

withTempWorkspace((ws) => {
  ws.write('templates/cv.md', 'template content');

  // copy: missing source
  assert(ws.copy('does-not-exist.md', 'dest.md') === false, 'copy() returns false on missing source');

  // copy: working
  assert(ws.copy('templates/cv.md', 'cv.md') === true, 'copy() succeeds when source exists');
  assert(ws.read('cv.md') === 'template content', 'copy() preserves content');

  // copy: auto-mkdir nested dest
  assert(ws.copy('templates/cv.md', 'reports/nested/copy.md') === true, 'copy() auto-creates dest dirs');
  assert(ws.exists('reports/nested/copy.md'), 'nested copy lands at expected path');

  // copy: recursive directory source
  ws.write('data/outreach/acme.md', 'Acme intro');
  ws.write('data/outreach/nested/globex.md', 'Globex intro');
  assert(ws.copy('data/outreach', 'archive/outreach') === true, 'copy() supports directory sources');
  assert(ws.read('archive/outreach/acme.md') === 'Acme intro', 'directory copy preserves direct child files');
  assert(ws.read('archive/outreach/nested/globex.md') === 'Globex intro', 'directory copy preserves nested child files');

  // delete
  assert(ws.delete('cv.md') === true, 'delete() returns true when file existed');
  assert(ws.exists('cv.md') === false, 'delete() actually removes');
  assert(ws.delete('cv.md') === false, 'delete() returns false for already-missing file');

  // mkdir
  ws.mkdir('output/foo/bar');
  assert(ws.exists('output/foo/bar'), 'mkdir creates nested dirs');
  ws.mkdir('output/foo/bar'); // idempotent
  assert(ws.exists('output/foo/bar'), 'mkdir is idempotent');
});

// ── 5. LIST / STAT ────────────────────────────────────────────────────

console.log('\n5. list / stat');

withTempWorkspace((ws) => {
  assert(ws.list('does-not-exist').length === 0, 'list() of missing dir returns []');

  ws.write('reports/001-acme.md', '');
  ws.write('reports/002-globex.md', '');
  ws.write('reports/003-initech.md', '');
  ws.mkdir('reports/archive');

  const all = ws.list('reports');
  assert(all.length === 4, 'list() returns all entries');
  assert(all.filter((e) => e.isFile).length === 3, '3 files reported');
  assert(all.filter((e) => e.isDirectory).length === 1, '1 directory reported');

  const filtered = ws.list('reports', { filter: (e) => e.name.startsWith('00') });
  assert(filtered.length === 3, 'list() filter narrows results');

  // stat
  assert(ws.stat('does-not-exist') === null, 'stat() of missing returns null');
  const st = ws.stat('reports/001-acme.md');
  assert(st && st.isFile(), 'stat() of file returns Stats with isFile()');
});

// ── 6. asWorkspace HELPER ─────────────────────────────────────────────

console.log('\n6. asWorkspace coercion');

withTempWorkspace((ws, dir) => {
  // Already a Workspace → returned as-is
  assert(asWorkspace(ws) === ws, 'asWorkspace() returns existing Workspace unchanged');

  // String root → wrapped
  const wrapped = asWorkspace(dir);
  assert(wrapped instanceof LocalWorkspace, 'asWorkspace(string) returns LocalWorkspace');
  assert(wrapped.root === ws.root, 'wrapped workspace has same root');

  // Empty/invalid
  assertThrows(() => asWorkspace({}), 'Cannot coerce', 'asWorkspace rejects unsupported type');
});

// ── 7. defaultWorkspace ENV RESOLUTION ────────────────────────────────

console.log('\n7. defaultWorkspace resolution order');

const originalEnv = process.env.CATABULL_WORKSPACE_ROOT;
try {
  // Env var wins
  process.env.CATABULL_WORKSPACE_ROOT = tmpdir();
  const fromEnv = defaultWorkspace('/nonexistent/fallback');
  assert(fromEnv.root === tmpdir() || fromEnv.root === tmpdir().replace(/\/$/, ''), 'env var overrides fallback');

  // No env, fallback wins
  delete process.env.CATABULL_WORKSPACE_ROOT;
  const fromFallback = defaultWorkspace(tmpdir());
  assert(
    fromFallback.root === tmpdir() || fromFallback.root === tmpdir().replace(/\/$/, ''),
    'fallback used when env unset'
  );
} finally {
  if (originalEnv == null) delete process.env.CATABULL_WORKSPACE_ROOT;
  else process.env.CATABULL_WORKSPACE_ROOT = originalEnv;
}

// ── DONE ──────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
