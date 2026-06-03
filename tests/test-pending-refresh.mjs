#!/usr/bin/env node

import {
  __resetPendingRefreshState,
  DEFAULT_PENDING_REFRESH_INTERVAL_MS,
  runPendingRefresh,
  shouldRunPendingRefresh,
} from '../dashboard-web/public/js/lib/pending-refresh.mjs';

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

console.log('\nPending refresh helper');

__resetPendingRefreshState();
assert(shouldRunPendingRefresh({ pendingCount: 0 }) === false, 'no pending rows skips refresh');
assert(shouldRunPendingRefresh({ pendingCount: 2, force: true }) === true, 'force bypasses throttle');
assert(shouldRunPendingRefresh({ pendingCount: 2, now: 10 }) === true, 'first run allowed');

__resetPendingRefreshState();
let checks = 0;
let reloads = 0;
let rerenders = 0;
const result = await runPendingRefresh({
  pendingCount: 3,
  now: 100,
  checkLivenessAll: async () => {
    checks++;
    return { checked: 3, expired: 1 };
  },
  reload: async () => { reloads++; },
  rerender: async () => { rerenders++; },
});
assert(result.checked === 3 && result.expired === 1, 'returns liveness summary');
assert(checks === 1, 'calls liveness once');
assert(reloads === 1, 'reload callback runs after liveness');
assert(rerenders === 1, 'rerender callback runs after reload');

const throttled = await runPendingRefresh({
  pendingCount: 3,
  now: 100 + DEFAULT_PENDING_REFRESH_INTERVAL_MS - 1,
  checkLivenessAll: async () => {
    checks++;
    return { checked: 3, expired: 0 };
  },
});
assert(throttled.skipped === 'throttled', 'second run inside interval is throttled');
assert(checks === 1, 'throttle prevents duplicate liveness call');

const forced = await runPendingRefresh({
  pendingCount: 3,
  force: true,
  now: 101,
  checkLivenessAll: async () => {
    checks++;
    return { checked: 3, expired: 0 };
  },
});
assert(forced.checked === 3, 'force reruns inside throttle window');
assert(checks === 2, 'force triggers second liveness call');

__resetPendingRefreshState();
let concurrentChecks = 0;
let release;
const blocker = new Promise((resolve) => { release = resolve; });
const first = runPendingRefresh({
  pendingCount: 2,
  now: 500,
  checkLivenessAll: async () => {
    concurrentChecks++;
    await blocker;
    return { checked: 2, expired: 0 };
  },
});
const second = runPendingRefresh({
  pendingCount: 2,
  now: 500,
  checkLivenessAll: async () => {
    concurrentChecks++;
    return { checked: 2, expired: 0 };
  },
});
release();
await Promise.all([first, second]);
assert(concurrentChecks === 1, 'in-flight run is shared across callers');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
