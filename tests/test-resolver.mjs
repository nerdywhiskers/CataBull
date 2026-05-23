#!/usr/bin/env node

/**
 * test-resolver.mjs — Unit tests for lib/workspace-resolver.mjs (PR 1.8).
 *
 * Uses temp dirs to simulate fresh-install / cwd-is-workspace / env-override
 * scenarios without touching the user's real ~/.catabull/.
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

const {
  looksLikeWorkspace,
  resolveWorkspaceRoot,
  scaffoldWorkspace,
  ensureWorkspace,
  RESOLUTION_REASONS,
} = await import('../lib/workspace-resolver.mjs');

console.log('\nlib/workspace-resolver.mjs');

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'catabull-resolver-test-'));
  try { return fn(dir); }
  finally { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// ── 1. looksLikeWorkspace ─────────────────────────────────────────────

console.log('\n1. looksLikeWorkspace');

withTemp((dir) => {
  assert(looksLikeWorkspace(dir) === false, 'empty dir → false');
});

withTemp((dir) => {
  writeFileSync(join(dir, 'cv.md'), '# CV');
  assert(looksLikeWorkspace(dir) === true, 'cv.md present → true');
});

withTemp((dir) => {
  writeFileSync(join(dir, 'portals.yml'), 'tracked_companies: []\n');
  assert(looksLikeWorkspace(dir) === true, 'portals.yml present → true');
});

withTemp((dir) => {
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'profile.yml'), 'candidate:\n  full_name: x\n');
  assert(looksLikeWorkspace(dir) === true, 'config/profile.yml present → true');
});

withTemp((dir) => {
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'applications.md'), '| # |\n');
  assert(looksLikeWorkspace(dir) === true, 'data/applications.md present → true');
});

withTemp((dir) => {
  // Random unrelated files don't count
  writeFileSync(join(dir, 'README.md'), '# random');
  writeFileSync(join(dir, 'package.json'), '{}');
  assert(looksLikeWorkspace(dir) === false, 'unrelated files → false');
});

assert(looksLikeWorkspace('') === false, 'empty string → false');
assert(looksLikeWorkspace(null) === false, 'null → false');
assert(looksLikeWorkspace(undefined) === false, 'undefined → false');

// ── 2. resolveWorkspaceRoot — env override ────────────────────────────

console.log('\n2. resolveWorkspaceRoot — env override');

withTemp((envDir) => {
  withTemp((cwdDir) => {
    withTemp((homeDir) => {
      const r = resolveWorkspaceRoot({
        env: { CATABULL_WORKSPACE_ROOT: envDir },
        cwd: cwdDir,
        home: homeDir,
        autoCreate: false,
      });
      assert(r.reason === 'env', 'env wins');
      assert(r.root === envDir, 'env path returned verbatim');
      assert(r.created === false, 'env path never marked created');
    });
  });
});

withTemp((cwdDir) => {
  withTemp((homeDir) => {
    // Empty env var should NOT win
    const r = resolveWorkspaceRoot({
      env: { CATABULL_WORKSPACE_ROOT: '   ' },
      cwd: cwdDir,
      home: homeDir,
      autoCreate: false,
    });
    assert(r.reason !== 'env', 'whitespace-only env ignored');
  });
});

// ── 3. resolveWorkspaceRoot — cwd detection ───────────────────────────

console.log('\n3. resolveWorkspaceRoot — cwd detection');

withTemp((cwdDir) => {
  // cwd looks like a workspace → use it
  writeFileSync(join(cwdDir, 'cv.md'), '# CV');
  withTemp((homeDir) => {
    const r = resolveWorkspaceRoot({
      env: {},
      cwd: cwdDir,
      home: homeDir,
      autoCreate: false,
    });
    assert(r.reason === 'cwd', 'cwd workspace detected');
    assert(r.root === cwdDir, 'cwd path returned');
  });
});

withTemp((cwdDir) => {
  // cwd doesn't look like workspace → fallback to home
  withTemp((homeDir) => {
    const r = resolveWorkspaceRoot({
      env: {},
      cwd: cwdDir,
      home: homeDir,
      autoCreate: false,
    });
    assert(r.reason === 'home', 'falls through to home');
    assert(r.root === join(homeDir, '.catabull'), 'home subdir is .catabull');
  });
});

// ── 4. resolveWorkspaceRoot — home auto-create ────────────────────────

console.log('\n4. resolveWorkspaceRoot — home auto-create');

withTemp((homeDir) => {
  const target = join(homeDir, '.catabull');
  assert(!existsSync(target), 'home subdir starts missing');
  const r = resolveWorkspaceRoot({
    env: {},
    cwd: tmpdir(),  // unrelated dir
    home: homeDir,
    autoCreate: true,
  });
  assert(r.created === true, 'created flag set when home subdir was made');
  assert(existsSync(target), 'home subdir mkdir-ed');

  // Subsequent call: dir exists → not created
  const r2 = resolveWorkspaceRoot({
    env: {},
    cwd: tmpdir(),
    home: homeDir,
    autoCreate: true,
  });
  assert(r2.created === false, 'second call sees existing dir, not created');
});

withTemp((homeDir) => {
  // autoCreate: false → no mkdir
  const r = resolveWorkspaceRoot({
    env: {},
    cwd: tmpdir(),
    home: homeDir,
    autoCreate: false,
  });
  assert(r.reason === 'home', 'home reason still set');
  assert(r.created === false, 'created false when autoCreate disabled');
  assert(!existsSync(join(homeDir, '.catabull')), 'home subdir NOT created');
});

// ── 5. resolveWorkspaceRoot — project fallback ────────────────────────

console.log('\n5. resolveWorkspaceRoot — project fallback');

withTemp((projectDir) => {
  // Project dir has cv.md → use it when allowed
  writeFileSync(join(projectDir, 'cv.md'), '# CV');
  withTemp((cwdDir) => {
    withTemp((homeDir) => {
      const r = resolveWorkspaceRoot({
        env: {},
        cwd: cwdDir,
        home: homeDir,
        projectRoot: projectDir,
        allowProjectFallback: true,
        autoCreate: false,
      });
      assert(r.reason === 'project', 'project fallback used');
      assert(r.root === projectDir, 'project path returned');
    });
  });
});

withTemp((projectDir) => {
  writeFileSync(join(projectDir, 'cv.md'), '# CV');
  withTemp((cwdDir) => {
    withTemp((homeDir) => {
      // allowProjectFallback: false → home wins instead
      const r = resolveWorkspaceRoot({
        env: {},
        cwd: cwdDir,
        home: homeDir,
        projectRoot: projectDir,
        allowProjectFallback: false,
        autoCreate: false,
      });
      assert(r.reason === 'home', 'project ignored when flag is false');
    });
  });
});

withTemp((projectDir) => {
  // Project dir without markers — fallback skipped
  withTemp((cwdDir) => {
    withTemp((homeDir) => {
      const r = resolveWorkspaceRoot({
        env: {},
        cwd: cwdDir,
        home: homeDir,
        projectRoot: projectDir,
        allowProjectFallback: true,
        autoCreate: false,
      });
      assert(r.reason === 'home', 'project without markers → home');
    });
  });
});

// ── 6. scaffoldWorkspace ──────────────────────────────────────────────

console.log('\n6. scaffoldWorkspace');

withTemp((pkgDir) => {
  // Set up a minimal "package" with templates
  writeFileSync(join(pkgDir, 'portals.example.yml'), 'tracked_companies: []\n');
  mkdirSync(join(pkgDir, 'config'));
  writeFileSync(join(pkgDir, 'config', 'profile.example.yml'), 'candidate: {}\n');

  withTemp((wsDir) => {
    const result = scaffoldWorkspace(pkgDir, wsDir, {
      templates: [
        { from: 'portals.example.yml', to: 'portals.yml.example' },
        { from: 'config/profile.example.yml', to: 'config/profile.example.yml' },
        { from: 'doesnt-exist.txt', to: 'whatever.txt' },
      ],
    });
    assert(result.copied.length === 2, 'copies existing template files');
    assert(result.copied.includes('portals.yml.example'), 'portals example copied');
    assert(existsSync(join(wsDir, 'portals.yml.example')), 'file present at dest');
    assert(existsSync(join(wsDir, 'config', 'profile.example.yml')), 'nested dest dir created');

    // Idempotent — second call skips
    const result2 = scaffoldWorkspace(pkgDir, wsDir, {
      templates: [
        { from: 'portals.example.yml', to: 'portals.yml.example' },
      ],
    });
    assert(result2.copied.length === 0, 'second call copies nothing');
    assert(result2.skipped.length === 1, 'second call skips already-present');
  });
});

// ── 7. ensureWorkspace — composition ──────────────────────────────────

console.log('\n7. ensureWorkspace — composition');

withTemp((pkgDir) => {
  // Minimal package mirroring the real layout the DEFAULT_TEMPLATES list
  // assumes (templates/, config/, modes/).
  mkdirSync(join(pkgDir, 'templates'));
  writeFileSync(join(pkgDir, 'templates', 'portals.example.yml'), 'tracked_companies: []\n');
  writeFileSync(join(pkgDir, 'templates', 'states.yml'), 'states: []\n');
  mkdirSync(join(pkgDir, 'config'));
  writeFileSync(join(pkgDir, 'config', 'profile.example.yml'), 'candidate: {}\n');
  mkdirSync(join(pkgDir, 'modes'));
  writeFileSync(join(pkgDir, 'modes', '_profile.template.md'), '# template');

  withTemp((homeDir) => {
    const r = ensureWorkspace({
      packageRoot: pkgDir,
      env: {},
      cwd: tmpdir(),
      home: homeDir,
    });
    assert(r.created === true, 'fresh ~/.catabull/ created');
    assert(r.scaffold && r.scaffold.copied.length > 0, 'templates copied to fresh workspace');
    assert(existsSync(join(homeDir, '.catabull', 'portals.yml.example')), 'sample portals file landed');

    // Second call doesn't re-scaffold
    const r2 = ensureWorkspace({
      packageRoot: pkgDir,
      env: {},
      cwd: tmpdir(),
      home: homeDir,
    });
    assert(r2.created === false, 'second call: not created');
    assert(r2.scaffold === null, 'second call: no scaffold info (existing workspace)');
  });
});

withTemp((cwdDir) => {
  // cwd already a workspace → ensureWorkspace doesn't scaffold home
  writeFileSync(join(cwdDir, 'cv.md'), '# CV');
  const r = ensureWorkspace({
    packageRoot: cwdDir,
    env: {},
    cwd: cwdDir,
    home: tmpdir(),  // unused
  });
  assert(r.reason === 'cwd', 'cwd preferred');
  assert(r.created === false, 'cwd path never marked created');
  assert(r.scaffold === null, 'cwd path never scaffolded');
});

// ── 8. RESOLUTION_REASONS contract ────────────────────────────────────

console.log('\n8. RESOLUTION_REASONS contract');

assert(Array.isArray(RESOLUTION_REASONS), 'exported as array');
for (const reason of ['env', 'cwd', 'home', 'project']) {
  assert(RESOLUTION_REASONS.includes(reason), `includes "${reason}"`);
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
