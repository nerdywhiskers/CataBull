#!/usr/bin/env node

/**
 * bin/catabull.mjs — global CLI entry (`npm install -g catabull`).
 *
 * Usage:
 *   catabull              start the dashboard at http://localhost:3737
 *   catabull doctor       run setup checks
 *   catabull scan         run a portal scan
 *   catabull scan-health  run a health check
 *   catabull --help       show this help
 *
 * On first run the CLI creates `~/.catabull/` as the user's workspace
 * (or uses cwd / CATABULL_WORKSPACE_ROOT if either points at an existing
 * workspace).
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { fileURLToPath } from 'url';
import {
  ensureWorkspace,
  looksLikeWorkspace,
  resolveWorkspaceRoot,
  writeGlobalWorkspacePreference,
  detectInstallKind,
} from '../lib/workspace-resolver.mjs';
import { ensurePlaywrightChromium } from '../lib/runtime-deps.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..');

const COMMANDS = {
  dashboard: { script: 'dashboard-web/server.mjs', label: 'Dashboard' },
  setup: { script: 'doctor.mjs', label: 'Setup' },
  doctor: { script: 'doctor.mjs', label: 'Doctor' },
  scan: { script: 'scan.mjs', label: 'Scan' },
  'scan-health': { script: 'scan-health.mjs', label: 'Scan health' },
  verify: { script: 'verify-pipeline.mjs', label: 'Verify pipeline' },
};

const HELP = `catabull — AI-powered job search dashboard
Usage:
  catabull                start the web dashboard (default)
  catabull setup          bootstrap first-run dependencies, then run doctor
  catabull doctor         validate setup
  catabull scan           run a portal scan (zero LLM tokens)
  catabull scan-health    health-check tracked companies
  catabull verify         pipeline integrity check
  catabull --version      print version
  catabull --help         this help

Environment:
  CATABULL_WORKSPACE_ROOT  override workspace location (default ~/.catabull/)
`;

function readVersion() {
  // Sync file read — small and works on every Node 18+ without import-attributes
  // syntax surprises. The package.json is right next to the bin script in
  // the published tarball.
  try {
    const json = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
    return json.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function promptForWorkspacePreference({ cwd, homeRoot }) {
  const rl = createInterface({ input, output });
  try {
    console.log('\nCataBull found two possible workspaces for this global install:');
    console.log(`  1) Home workspace (safe default): ${homeRoot}`);
    console.log(`  2) Current CataBull folder:        ${cwd}`);
    console.log('Choosing the current folder will use that working tree for data, but updates still target the global install.');

    while (true) {
      const answer = String(await rl.question('Pick workspace [1/2] (Enter for 1): ')).trim().toLowerCase();
      if (answer === '' || answer === '1' || answer === 'home' || answer === 'h') return 'home';
      if (answer === '2' || answer === 'cwd' || answer === 'c') return 'cwd';
      console.log('Please enter 1 or 2.');
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(readVersion());
    return;
  }

  // Default to dashboard if no subcommand.
  const subcommand = COMMANDS[cmd] ? cmd : 'dashboard';
  const passthrough = COMMANDS[cmd] ? args.slice(1) : args;
  const target = COMMANDS[subcommand];

  // Resolve workspace before spawning so the user sees the chosen root
  // (and any first-run scaffolding) regardless of which subcommand they ran.
  const installKind = detectInstallKind(PACKAGE_ROOT);
  const initialResolution = resolveWorkspaceRoot({
    cwd: process.cwd(),
    installKind,
    autoCreate: false,
  });

  let chosenPreference = initialResolution.preference;
  if (initialResolution.shouldPromptForWorkspacePreference) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      chosenPreference = await promptForWorkspacePreference({
        cwd: resolve(process.cwd()),
        homeRoot: initialResolution.root,
      });
      writeGlobalWorkspacePreference(chosenPreference);
    } else {
      console.log('Using global workspace by default because this run is non-interactive.');
      console.log('  To use the current CataBull folder instead, rerun interactively or set CATABULL_WORKSPACE_ROOT.');
      writeGlobalWorkspacePreference('home');
      chosenPreference = 'home';
    }
  }

  const ws = ensureWorkspace({
    packageRoot: PACKAGE_ROOT,
    installKind,
    globalWorkspacePreference: chosenPreference,
  });

  if (ws.created) {
    console.log(`\nWelcome — fresh CataBull install detected.`);
    console.log(`  Workspace created at: ${ws.root}`);
    if (ws.scaffold?.copied?.length) {
      console.log(`  Copied templates: ${ws.scaffold.copied.join(', ')}`);
    }
    console.log(`  Override anytime via CATABULL_WORKSPACE_ROOT.\n`);
  } else if (ws.reason === 'cwd') {
    console.log(`Using workspace at cwd: ${ws.root}`);
  } else if (ws.reason === 'env') {
    console.log(`Using workspace from CATABULL_WORKSPACE_ROOT: ${ws.root}`);
  } else if (ws.reason === 'home') {
    if (ws.installKind === 'npm-global') {
      console.log(`Using global workspace: ${ws.root}`);
      if (ws.preference === 'home' && looksLikeWorkspace(process.cwd()) && resolve(process.cwd()) !== resolve(ws.root)) {
        console.log('  Detected a CataBull workspace in the current folder, but leaving it alone to protect that working tree.');
        console.log('  Change the preference in Settings or set CATABULL_WORKSPACE_ROOT to target it explicitly.');
      }
    } else {
      console.log(`Using workspace: ${ws.root}`);
    }
  }

  if (subcommand === 'dashboard' || subcommand === 'setup') {
    const browser = await ensurePlaywrightChromium({
      cwd: PACKAGE_ROOT,
      logger: console,
      install: true,
    });
    if (!browser.ok) {
      console.error(`\n  ${browser.message}\n`);
      process.exit(1);
    }
  }

  // Spawn the target script with CATABULL_WORKSPACE_ROOT set so any
  // sub-process that re-resolves picks the same root. Inherit stdio so
  // the user sees output streaming live (dashboard logs, scan progress).
  const scriptPath = join(PACKAGE_ROOT, target.script);
  const child = spawn(process.execPath, [scriptPath, ...passthrough], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CATABULL_WORKSPACE_ROOT: ws.root,
    },
  });

  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`Failed to start ${target.label}: ${err.message}`);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
