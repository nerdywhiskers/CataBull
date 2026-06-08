export const DEFAULT_PENDING_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const PENDING_REFRESH_LAST_RUN_KEY = 'catabull-pending-refresh-last-run-at';

function refreshStorage() {
  if (typeof window !== 'undefined') return window.localStorage;
  return globalThis.__catabullPendingRefreshStorage || null;
}

function readPersistedLastRunAt() {
  try {
    const value = Number(refreshStorage()?.getItem(PENDING_REFRESH_LAST_RUN_KEY) || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function persistLastRunAt(value) {
  try { refreshStorage()?.setItem(PENDING_REFRESH_LAST_RUN_KEY, String(value)); } catch {}
}

function clearPersistedLastRunAt() {
  try { refreshStorage()?.removeItem(PENDING_REFRESH_LAST_RUN_KEY); } catch {}
}

const sharedState = {
  lastRunAt: readPersistedLastRunAt(),
  inFlight: null,
  status: {
    active: false,
    pendingCount: 0,
    source: 'auto',
    startedAt: 0,
    result: null,
    error: '',
  },
  listeners: new Set(),
};

function emit() {
  const snapshot = getPendingRefreshState();
  for (const listener of sharedState.listeners) {
    try { listener(snapshot); } catch {}
  }
}

function setStatus(next = {}) {
  sharedState.status = {
    ...sharedState.status,
    ...next,
  };
  emit();
}

export function getPendingRefreshState() {
  return {
    ...sharedState.status,
  };
}

export function subscribePendingRefresh(listener) {
  if (typeof listener !== 'function') return () => {};
  sharedState.listeners.add(listener);
  try { listener(getPendingRefreshState()); } catch {}
  return () => {
    sharedState.listeners.delete(listener);
  };
}

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
  source = force ? 'manual' : 'auto',
  checkLivenessAll,
  reload,
  rerender,
} = {}) {
  if (sharedState.inFlight) {
    const result = await sharedState.inFlight;
    if (typeof reload === 'function') await reload();
    if (typeof rerender === 'function') await rerender(result);
    return result;
  }
  if (!shouldRunPendingRefresh({ pendingCount, force, now, intervalMs })) {
    return { skipped: pendingCount <= 0 ? 'empty' : 'throttled' };
  }
  if (typeof checkLivenessAll !== 'function') throw new Error('checkLivenessAll is required');

  sharedState.lastRunAt = now;
  persistLastRunAt(now);
  setStatus({
    active: true,
    pendingCount,
    source,
    startedAt: now,
    result: null,
    error: '',
  });
  sharedState.inFlight = (async () => {
    try {
      const result = await checkLivenessAll();
      setStatus({ result, error: result?.error || '' });
      if (typeof reload === 'function') await reload();
      if (typeof rerender === 'function') await rerender(result);
      return result;
    } catch (error) {
      setStatus({ error: error?.message || String(error || '') });
      throw error;
    } finally {
      setStatus({ active: false });
      sharedState.inFlight = null;
    }
  })();

  return sharedState.inFlight;
}

export function __resetPendingRefreshState() {
  sharedState.lastRunAt = 0;
  clearPersistedLastRunAt();
  sharedState.inFlight = null;
  sharedState.status = {
    active: false,
    pendingCount: 0,
    source: 'auto',
    startedAt: 0,
    result: null,
    error: '',
  };
  emit();
}
