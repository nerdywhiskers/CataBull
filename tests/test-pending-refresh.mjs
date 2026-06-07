#!/usr/bin/env node

import {
  __resetPendingRefreshState,
  DEFAULT_PENDING_REFRESH_INTERVAL_MS,
  getPendingRefreshState,
  runPendingRefresh,
  shouldRunPendingRefresh,
  subscribePendingRefresh,
} from '../dashboard-web/public/js/lib/pending-refresh.mjs';

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;
const storage = new Map();
globalThis.__catabullPendingRefreshStorage = {
  getItem: (key) => storage.has(key) ? storage.get(key) : null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

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
const statusEvents = [];
const unsubscribe = subscribePendingRefresh((state) => {
  statusEvents.push({ active: state.active, pendingCount: state.pendingCount, source: state.source, error: state.error });
});
const result = await runPendingRefresh({
  pendingCount: 3,
  now: 100,
  source: 'manual',
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
assert(statusEvents.some((event) => event.active === true && event.pendingCount === 3 && event.source === 'manual'), 'status publishes active manual refresh state');
assert(getPendingRefreshState().active === false, 'status resets to inactive after completion');
assert(storage.get('catabull-pending-refresh-last-run-at') === '100', 'successful refresh persists throttle timestamp');
unsubscribe();

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
assert(!storage.has('catabull-pending-refresh-last-run-at'), 'reset clears persisted throttle timestamp');
let concurrentChecks = 0;
let firstReloads = 0;
let firstRerenders = 0;
let secondReloads = 0;
let secondRerenders = 0;
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
  reload: async () => { firstReloads++; },
  rerender: async () => { firstRerenders++; },
});
const second = runPendingRefresh({
  pendingCount: 2,
  now: 500,
  checkLivenessAll: async () => {
    concurrentChecks++;
    return { checked: 2, expired: 0 };
  },
  reload: async () => { secondReloads++; },
  rerender: async () => { secondRerenders++; },
});
release();
await Promise.all([first, second]);
assert(concurrentChecks === 1, 'in-flight run is shared across callers');
assert(firstReloads === 1 && firstRerenders === 1, 'first caller runs its reload and rerender callbacks');
assert(secondReloads === 1 && secondRerenders === 1, 'second caller joining in-flight run still gets reload and rerender callbacks');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
