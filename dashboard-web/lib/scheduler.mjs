import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// Package root (dashboard-web/lib → project root). scan.mjs ships here, not in
// the user's workspace, so the scheduler must launch it from the package and
// point it at the workspace via CATABULL_WORKSPACE_ROOT.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const STATE_FILE = 'data/scan-schedule-state.json';
const INTERVALS = {
  daily: 24 * 60 * 60 * 1000,
  'every-3-days': 3 * 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

let timer = null;
let running = false;
let lastResult = null;

function statePath(root) {
  return join(root, STATE_FILE);
}

function readState(root) {
  const path = statePath(root);
  if (!existsSync(path)) return { lastScanAt: null, lastScanResult: null };
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return { lastScanAt: null, lastScanResult: null }; }
}

function writeState(root, state) {
  writeFileSync(statePath(root), JSON.stringify(state, null, 2));
}

/** Read scan_schedule from portals.yml. Returns 'off', 'daily', 'every-3-days', or 'weekly'. */
export function getSchedule(root) {
  const path = join(root, 'portals.yml');
  if (!existsSync(path)) return 'off';
  try {
    const portals = yaml.load(readFileSync(path, 'utf-8'));
    return portals?.scan_schedule || 'off';
  } catch { return 'off'; }
}

/** Set scan_schedule in portals.yml using line-level replacement to preserve comments. */
export function setSchedule(root, schedule) {
  const path = join(root, 'portals.yml');
  let content = readFileSync(path, 'utf-8');

  if (content.includes('scan_schedule:')) {
    content = content.replace(/scan_schedule:\s*.+/, `scan_schedule: ${schedule}`);
  } else {
    // Add at the top of the file
    content = `scan_schedule: ${schedule}\n\n${content}`;
  }

  writeFileSync(path, content);
}

/** Get scheduler status for the API. */
export function getStatus(root) {
  const state = readState(root);
  const schedule = getSchedule(root);
  const interval = INTERVALS[schedule];

  let nextScanAt = null;
  if (schedule !== 'off' && state.lastScanAt) {
    nextScanAt = new Date(new Date(state.lastScanAt).getTime() + interval).toISOString();
  }

  return {
    schedule,
    running,
    lastScanAt: state.lastScanAt,
    lastScanResult: state.lastScanResult,
    nextScanAt,
  };
}

/** Run scan.mjs and return results. Optional opts.limit caps new offers added. */
export function runScan(root, opts = {}) {
  if (running) return Promise.resolve({ success: false, error: 'Scan already running' });
  running = true;

  const args = [join(PACKAGE_ROOT, 'scan.mjs'), '--mode', 'quick'];
  if (opts.company) {
    args.push('--company', String(opts.company));
  }
  if (opts.limit && Number.isFinite(opts.limit) && opts.limit > 0) {
    args.push('--limit', String(opts.limit));
  }

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, CATABULL_WORKSPACE_ROOT: root },
    });
    let stdout = '', stderr = '';

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', code => {
      running = false;
      const result = {
        success: code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timestamp: new Date().toISOString(),
      };

      // Count new offers found — matches "New offers added:      1"
      const newOffersMatch = stdout.match(/New offers added:\s+(\d+)/i);
      result.newOffers = newOffersMatch ? parseInt(newOffersMatch[1]) : 0;

      lastResult = result;

      if (!opts.company) {
        const state = {
          lastScanAt: result.timestamp,
          lastScanResult: {
            success: result.success,
            newOffers: result.newOffers,
            summary: result.stdout.split('\n').slice(-3).join(' ').substring(0, 200),
          },
        };
        writeState(root, state);
      }

      resolve(result);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      if (running) {
        proc.kill();
        running = false;
        resolve({ success: false, error: 'Scan timed out after 5 minutes' });
      }
    }, 300000);
  });
}

/** Start the scheduler loop. Checks on startup if a scan is overdue. */
export function startScheduler(root) {
  const schedule = getSchedule(root);
  if (schedule === 'off') return;

  const interval = INTERVALS[schedule];
  if (!interval) return;

  const state = readState(root);

  // Check if overdue
  if (state.lastScanAt) {
    const elapsed = Date.now() - new Date(state.lastScanAt).getTime();
    if (elapsed >= interval) {
      console.log(`  Scan overdue (last: ${state.lastScanAt}), running now...`);
      runScan(root);
    }
  } else {
    // Never scanned — run on first startup after a short delay
    setTimeout(() => runScan(root), 10000);
  }

  // Set up recurring timer (check every hour, run if interval elapsed)
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const currentSchedule = getSchedule(root);
    if (currentSchedule === 'off') return;

    const currentInterval = INTERVALS[currentSchedule];
    const currentState = readState(root);
    if (!currentState.lastScanAt) { runScan(root); return; }

    const elapsed = Date.now() - new Date(currentState.lastScanAt).getTime();
    if (elapsed >= currentInterval) {
      runScan(root);
    }
  }, 60 * 60 * 1000); // Check every hour
}

/** Stop the scheduler. */
export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Restart scheduler (call after schedule change). */
export function restartScheduler(root) {
  stopScheduler();
  startScheduler(root);
}
