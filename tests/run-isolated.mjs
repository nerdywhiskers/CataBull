#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv[2];
if (!requested) {
  console.error('Usage: node tests/run-isolated.mjs <test-file>');
  process.exit(2);
}

const workspace = mkdtempSync(resolve(tmpdir(), 'catabull-isolated-test-'));
try {
  const result = spawnSync(process.execPath, [resolve(root, requested)], {
    cwd: root,
    env: { ...process.env, CI: process.env.CI || '1', CATABULL_WORKSPACE_ROOT: workspace },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
