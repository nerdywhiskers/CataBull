/**
 * playwright-launch.mjs — chromium.launch with Windows-EPERM retry.
 *
 * On Windows, Defender real-time scan briefly locks chrome.exe between
 * spawns. A cold-start launch can also race with the scan during install
 * verification. Retry transient lock errors with backoff so callers don't
 * see a one-shot failure.
 *
 * Used by generate-pdf.mjs, check-liveness.mjs, and the webfetch scan
 * provider — anywhere we need a fresh browser on Windows.
 */

import { chromium } from 'playwright';

const TRANSIENT_PATTERN = /EPERM|EBUSY|ETXTBSY|operation not permitted/i;

function isTransient(err) {
  if (!err) return false;
  if (err.code && /^(EPERM|EBUSY|ETXTBSY)$/.test(err.code)) return true;
  return TRANSIENT_PATTERN.test(err.message || '');
}

/**
 * Launch chromium with retry on transient Windows file-lock errors.
 *
 * @param {object} [launchOptions]   Forwarded to chromium.launch (defaults headless:true).
 * @param {object} [retry]
 * @param {number} [retry.maxAttempts=3]   Total attempts (1 initial + retries).
 * @param {number} [retry.baseDelayMs=750] First backoff. Subsequent attempts double it.
 * @param {(msg:string)=>void} [retry.onWarn] Optional logger for retry attempts.
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchChromiumWithRetry(launchOptions = {}, retry = {}) {
  const { maxAttempts = 3, baseDelayMs = 750, onWarn } = retry;
  const opts = { headless: true, ...launchOptions };
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === maxAttempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, attempt);
      if (onWarn) onWarn(`Playwright launch transient error (${err.code || err.message}); retrying in ${delay}ms (attempt ${attempt + 2}/${maxAttempts})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted. If the failure looks like Windows blocking
  // chrome.exe, throw a wrapped error whose message tells the caller (or
  // the agent reading the log) exactly what to do — so the user doesn't
  // have to translate "EPERM" into "add a Defender exclusion".
  if (isTransient(lastErr) && process.platform === 'win32') {
    const wrapped = new Error(
      `Playwright chromium launch blocked by Windows after ${maxAttempts} attempts ` +
      `(${lastErr.code || 'EPERM'}). Defender / AV is likely the cause.\n` +
      `Fix (PowerShell as admin):\n` +
      `  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\\ms-playwright"\n` +
      `Then reinstall: npx playwright install chromium`
    );
    wrapped.cause = lastErr;
    wrapped.code = lastErr.code;
    throw wrapped;
  }

  throw lastErr;
}
