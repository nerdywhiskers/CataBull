#!/usr/bin/env node

import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import {
  applyGitPull,
  checkForUpdates,
  detectInstallKind,
  getUpdateStatus,
} from '../lib/update-manager.mjs';

console.log('\nupdate manager');

// --- detectInstallKind ---
{
  const dir = mkdtempSync(join(tmpdir(), 'catabull-update-detect-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.equal(detectInstallKind(dir), 'unsupported', 'plain dir w/ package.json is unsupported');

  // Fake an npm-global layout: <prefix>/node_modules/catabull/package.json
  const nmRoot = mkdtempSync(join(tmpdir(), 'catabull-update-nm-'));
  const nmInstall = join(nmRoot, 'node_modules', 'catabull');
  mkdirSync(nmInstall, { recursive: true });
  writeFileSync(join(nmInstall, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.equal(detectInstallKind(nmInstall), 'npm-global', 'node_modules/catabull layout = npm-global');

  // npm-global must win even if the packaged files happen to contain a .git dir
  // (for example from an overly eager installer or copied checkout).
  mkdirSync(join(nmInstall, '.git'), { recursive: true });
  assert.equal(detectInstallKind(nmInstall), 'npm-global', 'npm-global layout beats accidental .git presence');

  // Git checkout: has .git directory.
  const gitDir = mkdtempSync(join(tmpdir(), 'catabull-update-git-'));
  run('git', ['init', '-b', 'main'], gitDir);
  writeFileSync(join(gitDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.equal(detectInstallKind(gitDir), 'git-checkout', '.git presence = git-checkout');
}

// --- getUpdateStatus on unsupported install ---
{
  const dir = mkdtempSync(join(tmpdir(), 'catabull-update-unsupported-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const status = await getUpdateStatus(dir, { repo: 'invalid/__never__exists__' });
  assert.equal(status.supported, false);
  assert.equal(status.installKind, 'unsupported');
  assert.equal(status.localVersion, '9.9.9');
  assert.equal(status.canUpdate, false);
  assert.equal(status.canGitPull, false);
}

// --- npm-global status — remote-fetch failure surfaces but doesn't crash ---
{
  const nmRoot = mkdtempSync(join(tmpdir(), 'catabull-update-nm-status-'));
  const install = join(nmRoot, 'node_modules', 'catabull');
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  // Use a guaranteed-failing repo so we don't hit the real network in CI.
  const status = await getUpdateStatus(install, { repo: 'invalid-owner/__catabull_test__no_such_repo__', httpTimeoutMs: 2_000 });
  assert.equal(status.supported, true);
  assert.equal(status.installKind, 'npm-global');
  assert.equal(status.localVersion, '1.0.0');
  assert.equal(status.canGitPull, false);
  // remoteVersion is '' on failure; updateAvailable must stay false.
  assert.equal(status.updateAvailable, false);
  assert.match(status.message, /Could not check GitHub|up to date/);
}

// --- git-checkout status + git pull happy path + dirty-block ---
{
  const remote = mkdtempSync(join(tmpdir(), 'catabull-update-remote-'));
  run('git', ['init', '--bare'], remote);

  const seed = mkdtempSync(join(tmpdir(), 'catabull-update-seed-'));
  run('git', ['init', '-b', 'main'], seed);
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  run('git', ['add', 'package.json'], seed);
  run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'initial'], seed);
  run('git', ['remote', 'add', 'origin', remote], seed);
  run('git', ['push', '-u', 'origin', 'main'], seed);

  const local = mkdtempSync(join(tmpdir(), 'catabull-update-local-'));
  run('git', ['clone', remote, local]);
  run('git', ['checkout', 'main'], local);
  assert.ok(existsSync(join(local, '.git')));

  // Force the same repo path for remote-version fetch to fail — we only care
  // about the git-commit comparison here.
  const opts = { repo: 'invalid-owner/__catabull_test_git__', httpTimeoutMs: 2_000 };

  let status = await checkForUpdates(local, opts);
  assert.equal(status.supported, true);
  assert.equal(status.installKind, 'git-checkout');
  assert.equal(status.updateAvailable, false);
  assert.equal(status.canGitPull, false, 'no remote commits ahead → no pull');

  writeFileSync(join(seed, 'package.json'), JSON.stringify({ version: '1.0.1' }));
  run('git', ['add', 'package.json'], seed);
  run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'update'], seed);
  run('git', ['push'], seed);

  status = await checkForUpdates(local, opts);
  assert.equal(status.updateAvailable, true, 'remote commit ahead → updateAvailable');
  assert.equal(status.canGitPull, true, 'clean tree on main with remote ahead → canGitPull');

  const pullResult = await applyGitPull(local, opts);
  assert.equal(pullResult.success, true);
  assert.equal(pullResult.installKind, 'git-checkout');
  assert.equal(pullResult.after.updateAvailable, false);

  // Dirty tree blocks subsequent pulls.
  writeFileSync(join(local, 'data-local.txt'), 'dirty');
  // Need another remote commit to make canGitPull relevant.
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ version: '1.0.2' }));
  run('git', ['add', 'package.json'], seed);
  run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'next'], seed);
  run('git', ['push'], seed);

  status = await checkForUpdates(local, opts);
  assert.equal(status.dirty, true);
  assert.equal(status.canGitPull, false, 'dirty tree blocks git pull');
  assert.equal(status.canUpdate, true, 'npm update path is still offered');

  const blocked = await applyGitPull(local, opts);
  assert.equal(blocked.success, false);
  assert.equal(blocked.status, 'blocked');
}

console.log('  ok');

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}
