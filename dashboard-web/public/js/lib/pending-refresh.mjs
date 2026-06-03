export const DEFAULT_PENDING_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const sharedState = {
  lastRunAt: 0,
  inFlight: null,
};

export function shouldRunPendingRefresh({
  pendingCount = 0,
  force = false,
  now = Date.now(),
  intervalMs = DEFAULT_PENDING_REFRESH_INTERVAL_MS,
} = {}) {
  if (pendingCount <= 0) return false;
  if (force) return true;
  return !sharedState.lastRunAt || (now - sharedState.lastRunAt) >= intervalMs;
}

export async function runPendingRefresh({
  pendingCount = 0,
  force = false,
  now = Date.now(),
  intervalMs = DEFAULT_PENDING_REFRESH_INTERVAL_MS,
  checkLivenessAll,
  reload,
  rerender,
} = {}) {
  if (!shouldRunPendingRefresh({ pendingCount, force, now, intervalMs })) {
    return { skipped: pendingCount <= 0 ? 'empty' : 'throttled' };
  }
  if (sharedState.inFlight) return sharedState.inFlight;
  if (typeof checkLivenessAll !== 'function') throw new Error('checkLivenessAll is required');

  sharedState.lastRunAt = now;
  sharedState.inFlight = (async () => {
    try {
      const result = await checkLivenessAll();
      if (typeof reload === 'function') await reload();
      if (typeof rerender === 'function') await rerender(result);
      return result;
    } finally {
      sharedState.inFlight = null;
    }
  })();

  return sharedState.inFlight;
}

export function __resetPendingRefreshState() {
  sharedState.lastRunAt = 0;
  sharedState.inFlight = null;
}
