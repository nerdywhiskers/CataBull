import { existsSync } from 'fs';
import { execSync } from 'child_process';

function browserMissing(playwright) {
  try {
    return !existsSync(playwright.chromium.executablePath());
  } catch {
    return true;
  }
}

export async function ensurePlaywrightChromium({
  cwd = process.cwd(),
  logger = console,
  install = true,
} = {}) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return {
      ok: false,
      installed: false,
      reason: 'missing-playwright',
      message: 'Playwright is not installed.',
    };
  }

  if (!browserMissing(playwright)) {
    return { ok: true, installed: false, reason: 'already-installed' };
  }

  if (!install) {
    return {
      ok: false,
      installed: false,
      reason: 'missing-chromium',
      message: 'Playwright chromium is not installed.',
    };
  }

  logger.log('\n  Installing Playwright browser (chromium, first run only)...\n');
  try {
    execSync('npx playwright install chromium', { cwd, stdio: 'inherit' });
    return { ok: true, installed: true, reason: 'installed' };
  } catch (err) {
    const isWindows = process.platform === 'win32';
    const windowsHint = isWindows
      ? '\n  If Windows Defender blocked the download, run `careerbot doctor` after allowlisting %LOCALAPPDATA%\\ms-playwright.'
      : '';
    return {
      ok: false,
      installed: false,
      reason: 'install-failed',
      message:
        'Failed to install Playwright chromium automatically.' +
        '\n  Run: npx playwright install chromium' +
        windowsHint,
      cause: err,
    };
  }
}
