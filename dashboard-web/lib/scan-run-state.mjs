import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const STATE_FILE = 'data/scan-run-state.json';

function statePath(root) {
  return join(root, STATE_FILE);
}

function defaultState() {
  return {
    active: false,
    mode: null,
    startedAt: null,
    updatedAt: null,
    stage: null,
    progress: null,
    lastResult: null,
  };
}

export function readScanRunState(root) {
  const path = statePath(root);
  if (!existsSync(path)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? { ...defaultState(), ...parsed } : defaultState();
  } catch {
    return defaultState();
  }
}

export function writeScanRunState(root, patch = {}) {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const next = {
    ...readScanRunState(root),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(next, null, 2));
  return next;
}

export function startScanRun(root, { mode, stage = null, progress = null } = {}) {
  const now = new Date().toISOString();
  return writeScanRunState(root, {
    active: true,
    mode: mode || null,
    startedAt: now,
    updatedAt: now,
    stage,
    progress,
    lastResult: null,
  });
}

export function updateScanRun(root, { stage = null, progress = null } = {}) {
  return writeScanRunState(root, { active: true, stage, progress });
}

export function finishScanRun(root, { mode = null, status = 'completed', summary = null, error = null } = {}) {
  return writeScanRunState(root, {
    active: false,
    mode,
    stage: null,
    progress: null,
    lastResult: {
      status,
      summary,
      error,
      finishedAt: new Date().toISOString(),
    },
  });
}
