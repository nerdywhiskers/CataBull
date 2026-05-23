/**
 * spawn-timeout.mjs — Shared utility for spawning child Node processes
 * with soft + hard timeout and guaranteed single resolution.
 *
 * Used by: actions.mjs, scheduler.mjs, metrics.mjs
 * Replaces 4 duplicated implementations of the same pattern.
 */
import { spawn } from 'child_process';

/** Resolve the node binary path reliably across platforms. */
function nodeBin() {
  return process.execPath;
}

/**
 * Spawn a Node script with timeout, SIGTERM escalation, and single resolution.
 *
 * @param {string} script - Path to the .mjs script
 * @param {string[]} args - Arguments to pass
 * @param {object} opts
 * @param {string} opts.cwd - Working directory
 * @param {number} opts.timeoutMs - Soft timeout (SIGTERM). Hard timeout = timeoutMs + 5000
 * @param {object} [opts.env] - Child env (defaults to inheriting process.env).
 *   Pass `{ ...process.env, CATABULL_WORKSPACE_ROOT: <workspace> }` so the
 *   spawned script resolves data against the user's workspace, not its own
 *   package location (the two differ in a ~/.catabull home install).
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string}>}
 *   exitCode === -1 means timed out (SIGKILL); -2 means spawn failed
 */
export function spawnWithTimeout(script, args = [], { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    let proc;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
      resolve(payload);
    };

    try {
      proc = spawn(nodeBin(), [script, ...args], { cwd, env });
    } catch (err) {
      return resolve({ exitCode: -2, stdout: '', stderr: `spawn failed: ${err.message}` });
    }

    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', err => finish({ exitCode: -2, stdout, stderr: `${stderr}\nspawn error: ${err.message}` }));
    proc.on('close', code => finish({ exitCode: code, stdout, stderr }));

    const softTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    const hardTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish({ exitCode: -1, stdout, stderr: stderr + '\nProcess timed out.' });
    }, timeoutMs + 5000);
  });
}

/**
 * Spawn a Node script with a shorter timeout (for quick operations).
 * Default: 120s soft, 125s hard.
 */
export function spawnQuick(script, args = [], { cwd } = {}) {
  return spawnWithTimeout(script, args, { cwd, timeoutMs: 120_000 });
}

/**
 * Spawn a Node script with a longer timeout (for heavy operations).
 * Default: 300s soft, 305s hard.
 */
export function spawnHeavy(script, args = [], { cwd } = {}) {
  return spawnWithTimeout(script, args, { cwd, timeoutMs: 300_000 });
}
