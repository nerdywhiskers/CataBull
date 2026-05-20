#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for CareerBot
 * Checks all prerequisites and prints a pass/fail checklist.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ensureWorkspace } from '../lib/workspace-resolver.mjs';
import { ensurePlaywrightChromium } from '../lib/runtime-deps.mjs';
import { loadEnvFile } from '../lib/load-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `packageRoot` is where the code lives (this script's directory); the
// `workspaceRoot` is where user data lives (resolver picks). For most
// dev installs they're the same; for a globally installed CLI they differ.
const packageRoot = resolve(__dirname, '..');
const resolved = ensureWorkspace({
  packageRoot,
  projectRoot: packageRoot,
  allowProjectFallback: true,
});
const projectRoot = resolved.root;
loadEnvFile(projectRoot);

// ANSI colors (only on TTY)
const isTTY = process.stdout.isTTY;
const green = (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const dim = (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s;

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 18) {
    return { pass: true, label: `Node.js >= 18 (v${process.versions.node})` };
  }
  return {
    pass: false,
    label: `Node.js >= 18 (found v${process.versions.node})`,
    fix: 'Install Node.js 18 or later from https://nodejs.org',
  };
}

async function checkDependencies() {
  // Don't look for `packageRoot/node_modules` — npm hoists deps to the
  // top-level node_modules during a global install, so the package's
  // own dir won't have one. Try to actually resolve a key dep instead.
  try {
    await import('fastify');
    return { pass: true, label: 'Dependencies installed' };
  } catch {
    return {
      pass: false,
      label: 'Dependencies not installed',
      fix: 'Run: npm install',
    };
  }
}

async function checkPlaywright() {
  const runtime = await ensurePlaywrightChromium({
    cwd: packageRoot,
    logger: { log() {} },
    install: false,
  });

  if (runtime.reason === 'missing-playwright') {
    return {
      pass: false,
      label: 'Playwright not installed',
      fix: 'Run: npx careerbot@latest',
    };
  }

  if (runtime.reason === 'missing-chromium') {
    return {
      pass: false,
      label: 'Playwright chromium not installed',
      fix: 'Run: npx careerbot@latest',
    };
  }

  const { chromium } = await import('playwright');

  // Actually launch the browser. Just checking that the executable exists
  // doesn't catch AV quarantine, partial downloads, missing system libs,
  // or file-permission issues — and those are exactly the failures users
  // hit at first-PDF time, not at install time.
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 15000 });
    await browser.close();
    return { pass: true, label: 'Playwright chromium launches OK' };
  } catch (err) {
    try { if (browser) await browser.close(); } catch {}
    const msg = (err?.message || '').split('\n')[0];
    const transient = err?.code === 'EPERM' || /EPERM|EBUSY|ETXTBSY|operation not permitted/i.test(msg);
    const isWin = process.platform === 'win32';

    if (transient && isWin) {
      return {
        pass: false,
        label: `Playwright chromium launch blocked (${err.code || 'EPERM'})`,
        fix: [
          'Windows is blocking chrome.exe — usually Defender real-time scan or AV quarantine.',
          'Allowlist the Playwright cache (PowerShell as admin):',
          '  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\\ms-playwright"',
          'Then reinstall to clear any quarantined files:',
          '  npx playwright install chromium',
        ],
      };
    }

    return {
      pass: false,
      label: `Playwright chromium launch failed: ${msg}`,
      fix: [
        'Reinstall the browser: npx playwright install chromium',
        isWin
          ? 'If it keeps failing, check Windows Defender hasn\'t quarantined chrome.exe at %LOCALAPPDATA%\\ms-playwright'
          : 'Make sure the chromium executable has execute permission and required system libs are present',
      ],
    };
  }
}

function checkCv() {
  if (existsSync(join(projectRoot, 'cv.md'))) {
    return { pass: true, label: 'cv.md found' };
  }
  return {
    pass: false,
    label: 'cv.md not found',
    fix: [
      'Create cv.md in the project root with your CV in markdown',
      'See examples/ for reference CVs',
    ],
  };
}

function checkProfile() {
  if (existsSync(join(projectRoot, 'config', 'profile.yml'))) {
    return { pass: true, label: 'config/profile.yml found' };
  }
  return {
    pass: false,
    label: 'config/profile.yml not found',
    fix: [
      'Run: cp config/profile.example.yml config/profile.yml',
      'Then edit it with your details',
    ],
  };
}

function checkPortals() {
  if (existsSync(join(projectRoot, 'portals.yml'))) {
    return { pass: true, label: 'portals.yml found' };
  }
  return {
    pass: false,
    label: 'portals.yml not found',
    fix: [
      'Run: cp templates/portals.example.yml portals.yml',
      'Then customize with your target companies',
    ],
  };
}

// Optional: only needed if you use the `latex` mode for CV export. The default
// CV flow uses `generate-pdf.mjs` (HTML→PDF via Playwright) and doesn't need
// pdflatex. We mark this `optional: true` so a missing TeX install warns but
// doesn't fail `npm run doctor`.
function checkPdflatex() {
  try {
    execFileSync('pdflatex', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return { pass: true, label: 'pdflatex on PATH (optional, for latex mode)' };
  } catch {
    return {
      pass: false,
      optional: true,
      label: 'pdflatex not found (optional, only needed for latex mode)',
      fix: [
        'Install a TeX distribution if you want LaTeX/Overleaf CV export:',
        '  Windows: https://miktex.org or https://tug.org/texlive',
        '  macOS:   brew install --cask mactex-no-gui (or basictex for a smaller install)',
        '  Linux:   apt install texlive-latex-recommended texlive-fonts-extra',
      ],
    };
  }
}

function checkFonts() {
  // Fonts ship with the package (used for ATS-PDF rendering). They live
  // alongside the code, not in the user's workspace.
  const fontsDir = join(packageRoot, 'fonts');
  if (!existsSync(fontsDir)) {
    return {
      pass: false,
      label: 'fonts/ directory not found',
      fix: 'The fonts/ directory is required for PDF generation',
    };
  }
  try {
    const files = readdirSync(fontsDir);
    if (files.length === 0) {
      return {
        pass: false,
        label: 'fonts/ directory is empty',
        fix: 'The fonts/ directory must contain font files for PDF generation',
      };
    }
  } catch {
    return {
      pass: false,
      label: 'fonts/ directory not readable',
      fix: 'Check permissions on the fonts/ directory',
    };
  }
  return { pass: true, label: 'Fonts directory ready' };
}

function checkStoryBank() {
  // Target (user data) lives in workspace; source (template) ships with package.
  const target = join(projectRoot, 'interview-prep', 'story-bank.md');
  if (existsSync(target)) {
    return { pass: true, label: 'interview-prep/story-bank.md ready' };
  }
  const source = join(packageRoot, 'templates', 'story-bank.example.md');
  if (!existsSync(source)) {
    return {
      pass: false,
      label: 'interview-prep/story-bank.md not found',
      fix: 'Template missing too — restore templates/story-bank.example.md from git',
    };
  }
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    return { pass: true, label: 'interview-prep/story-bank.md ready (auto-created from template)' };
  } catch {
    return {
      pass: false,
      label: 'interview-prep/story-bank.md could not be created',
      fix: 'Run: cp templates/story-bank.example.md interview-prep/story-bank.md',
    };
  }
}

function checkJobSpy() {
  // JobSpy is Deep Scan Level 4 — opt-in via Python install. We detect a
  // Python runner that can run the sidecar. Missing JobSpy is a *warning*,
  // not a failure — Deep Scan works without it (using Brave WebSearch Level 3).
  const findExe = (name) => {
    const PATH = process.env.PATH || '';
    const sep = process.platform === 'win32' ? ';' : ':';
    const exts = process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
      : [''];
    for (const dir of PATH.split(sep)) {
      if (!dir) continue;
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  };

  const uv = findExe('uv');
  if (uv) {
    return {
      pass: true,
      label: 'JobSpy runner: uv (jobspy installed on demand via `uv run --with python-jobspy`)',
    };
  }
  const py = findExe('python3') || findExe('python');
  if (py) {
    return {
      pass: true,
      label: `JobSpy runner: ${py}`,
      note: 'pip install python-jobspy if Level 4 Deep Scan shows "python-jobspy not installed".',
    };
  }
  return {
    pass: true,
    optional: true,
    label: 'JobSpy (Deep Scan Level 4) — not detected',
    fix: 'Install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) or python3 to unlock Indeed / Wellfound / Glassdoor / Google Jobs / ZipRecruiter scraping.',
  };
}

function checkWebSearchProvider() {
  // Deep Scan Level 3 uses scan/websearch.mjs. The provider is selected
  // via CAREERBOT_WEBSEARCH, or auto-selected from available API keys.
  // brave/serper require an API key; scrape works without a key but is
  // fragile.
  const requested = (process.env.CAREERBOT_WEBSEARCH || '').toLowerCase()
    || (process.env.BRAVE_SEARCH_API_KEY ? 'brave'
      : process.env.SERPER_API_KEY ? 'serper'
        : 'scrape');
  if (requested === 'brave') {
    if (process.env.BRAVE_SEARCH_API_KEY) {
      return { pass: true, label: 'WebSearch provider: brave (key present)' };
    }
    return {
      pass: false,
      label: 'WebSearch provider: brave (BRAVE_SEARCH_API_KEY missing)',
      fix: 'Sign up at https://api.search.brave.com/ (2k req/mo free) and set BRAVE_SEARCH_API_KEY in your env.',
    };
  }
  if (requested === 'serper') {
    if (process.env.SERPER_API_KEY) {
      return { pass: true, label: 'WebSearch provider: serper (key present)' };
    }
    return {
      pass: false,
      label: 'WebSearch provider: serper (SERPER_API_KEY missing)',
      fix: 'Sign up at https://serper.dev/ and set SERPER_API_KEY in your env.',
    };
  }
  // scrape / ddg / default
  return {
    pass: true,
    label: 'WebSearch provider: scrape (DuckDuckGo HTML, no key required)',
    note: 'Best-effort scraping — for reliable Deep Scan set BRAVE_SEARCH_API_KEY in .env or set CAREERBOT_WEBSEARCH=brave.',
  };
}

function checkAutoDir(name) {
  const dirPath = join(projectRoot, name);
  if (existsSync(dirPath)) {
    return { pass: true, label: `${name}/ directory ready` };
  }
  try {
    mkdirSync(dirPath, { recursive: true });
    return { pass: true, label: `${name}/ directory ready (auto-created)` };
  } catch {
    return {
      pass: false,
      label: `${name}/ directory could not be created`,
      fix: `Run: mkdir ${name}`,
    };
  }
}

async function main() {
  console.log('\nCareerBot doctor');
  console.log('================\n');

  // Surface package vs workspace explicitly so a globally installed CLI
  // user can see "is this checking my data, or just the install?"
  console.log(`Package root:   ${packageRoot}`);
  console.log(`Workspace root: ${projectRoot} ${dim(`(${resolved.reason})`)}`);
  if (resolved.created) {
    console.log(`${dim('  (workspace created on this run)')}`);
  }
  console.log('');

  const checks = [
    checkNodeVersion(),
    await checkDependencies(),
    await checkPlaywright(),
    checkPdflatex(),
    checkCv(),
    checkProfile(),
    checkPortals(),
    checkFonts(),
    checkStoryBank(),
    checkAutoDir('data'),
    checkAutoDir('data/outreach'),
    checkAutoDir('output'),
    checkAutoDir('reports'),
    checkWebSearchProvider(),
    checkJobSpy(),
  ];

  let failures = 0;
  let warnings = 0;

  for (const result of checks) {
    if (result.pass) {
      console.log(`${green('✓')} ${result.label}`);
      if (result.note) console.log(`  ${dim('· ' + result.note)}`);
    } else {
      const optional = result.optional === true;
      if (optional) warnings++; else failures++;
      console.log(`${optional ? yellow('!') : red('✗')} ${result.label}`);
      const fixes = Array.isArray(result.fix) ? result.fix : [result.fix];
      for (const hint of fixes) {
        console.log(`  ${dim('→ ' + hint)}`);
      }
    }
  }

  console.log('');
  if (failures > 0) {
    const warnSuffix = warnings > 0 ? `, ${warnings} optional warning${warnings === 1 ? '' : 's'}` : '';
    console.log(`Result: ${failures} issue${failures === 1 ? '' : 's'} found${warnSuffix}. Fix them and run \`npm run doctor\` again.`);
    process.exit(1);
  } else if (warnings > 0) {
    console.log(`Result: All required checks passed (${warnings} optional warning${warnings === 1 ? '' : 's'}). Run \`npm run dashboard\` to start.`);
    process.exit(0);
  } else {
    console.log('Result: All checks passed. You\'re ready to go! Run `npm run dashboard` to start.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('doctor.mjs failed:', err.message);
  process.exit(1);
});
