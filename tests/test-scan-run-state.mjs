#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nscan run state persistence');

const {
  readScanRunState,
  startScanRun,
  updateScanRun,
  finishScanRun,
} = await import(pathToFileURL(join(ROOT, 'dashboard-web/lib/scan-run-state.mjs')).href);
const { getStatus } = await import(pathToFileURL(join(ROOT, 'dashboard-web/lib/scheduler.mjs')).href);

const root = mkdtempSync(join(tmpdir(), 'catabull-scan-state-'));

try {
  const empty = readScanRunState(root);
  assert(empty.active === false, 'empty state defaults inactive');
  assert(empty.lastResult === null, 'empty state has no last result');

  const started = startScanRun(root, {
    mode: 'quick',
    stage: 'quick:start',
    progress: { stage: 'quick:start' },
  });
  assert(started.active === true, 'startScanRun marks state active');
  assert(started.mode === 'quick', 'startScanRun stores mode');
  assert(started.progress?.stage === 'quick:start', 'startScanRun stores progress payload');

  const updated = updateScanRun(root, {
    stage: 'quick:company:done',
    progress: { stage: 'quick:company:done', company: 'Acme', added: 2 },
  });
  assert(updated.active === true, 'updateScanRun keeps state active');
  assert(updated.progress?.company === 'Acme', 'updateScanRun overwrites progress payload');

  const finished = finishScanRun(root, {
    mode: 'quick',
    status: 'completed',
    summary: { totalNew: 2 },
  });
  assert(finished.active === false, 'finishScanRun marks state inactive');
  assert(finished.lastResult?.status === 'completed', 'finishScanRun stores completion status');
  assert(finished.lastResult?.summary?.totalNew === 2, 'finishScanRun stores completion summary');
  assert(finished.progress === null, 'finishScanRun clears active progress payload');

  const reread = readScanRunState(root);
  assert(reread.lastResult?.finishedAt, 'state reread preserves finished timestamp');
  assert(reread.mode === 'quick', 'state reread preserves mode');

  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'portals.yml'), 'scan_schedule: weekly\n');
  writeFileSync(join(root, 'data/scan-schedule-state.json'), JSON.stringify({
    lastScanAt: '2026-06-01T00:00:00.000Z',
    lastScanResult: { success: true, newOffers: 0, summary: 'old scan' },
  }, null, 2));
  const status = getStatus(root);
  assert(status.lastScanAt === reread.lastResult.finishedAt, 'scan status prefers newer streamed run timestamp');
  assert(status.lastScanResult?.newOffers === 2, 'scan status derives new offer count from streamed run summary');
  assert(status.nextScanAt && status.nextScanAt > status.lastScanAt, 'nextScanAt uses newest scan time');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exit(1);
