#!/usr/bin/env node

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeSchedulerState } from '../dashboard-web/lib/scheduler.mjs';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed++;
  else { failed++; console.log(`  ❌ ${message}`); }
}

console.log('\nscheduler state persistence');

const root = mkdtempSync(join(tmpdir(), 'catabull-scheduler-test-'));
try {
  const state = {
    lastScanAt: '2026-08-05T12:00:00.000Z',
    lastScanResult: { success: true, newOffers: 2, summary: '2 new offers' },
  };
  writeSchedulerState(root, state);
  const statePath = join(root, 'data', 'scan-schedule-state.json');
  assert(existsSync(statePath), 'fresh workspace creates data directory and scheduler state file');
  assert(JSON.parse(readFileSync(statePath, 'utf8')).lastScanResult.newOffers === 2, 'scheduler state round-trips');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`Passed: ${passed} / ${passed + failed}`);
if (failed) process.exit(1);
