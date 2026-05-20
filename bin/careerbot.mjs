#!/usr/bin/env node

/**
 * bin/careerbot.mjs — global CLI entry (`npm install -g careerbot`).
 *
 * Usage:
 *   careerbot              start the dashboard at http://localhost:3737
 *   careerbot doctor       run setup checks
 *   careerbot scan         run a portal scan
 *   careerbot scan-health  run a health check
 *   careerbot --help       show this help
 *
 * On first run the CLI creates `~/.careerbot/` as the user's workspace
 * (or uses cwd / CAREERBOT_WORKSPACE_ROOT if either points at an existing
 * workspace).
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ensureWorkspace } from '../lib/workspace-resolver.mjs';
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

const HELP = `careerbot — AI-powered job search dashboard
Usage:
  careerbot                start the web dashboard (default)
  careerbot setup          bootstrap first-run dependencies, then run doctor
  careerbot doctor         validate setup
  careerbot scan           run a portal scan (zero LLM tokens)
  careerbot scan-health    health-check tracked companies
  careerbot verify         pipeline integrity check
  careerbot --version      print version
  careerbot --help         this help

Environment:
  CAREERBOT_WORKSPACE_ROOT  override workspace location (default ~/.careerbot/)
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
  const ws = ensureWorkspace({ packageRoot: PACKAGE_ROOT });

  if (ws.created) {
    console.log(`\nWelcome — fresh CareerBot install detected.`);
    console.log(`  Workspace created at: ${ws.root}`);
    if (ws.scaffold?.copied?.length) {
      console.log(`  Copied templates: ${ws.scaffold.copied.join(', ')}`);
    }
    console.log(`  Override anytime via CAREERBOT_WORKSPACE_ROOT.\n`);
  } else if (ws.reason === 'cwd') {
    console.log(`Using workspace at cwd: ${ws.root}`);
  } else if (ws.reason === 'env') {
    console.log(`Using workspace from CAREERBOT_WORKSPACE_ROOT: ${ws.root}`);
  } else if (ws.reason === 'home') {
    console.log(`Using workspace: ${ws.root}`);
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

  // Spawn the target script with CAREERBOT_WORKSPACE_ROOT set so any
  // sub-process that re-resolves picks the same root. Inherit stdio so
  // the user sees output streaming live (dashboard logs, scan progress).
  const scriptPath = join(PACKAGE_ROOT, target.script);
  const child = spawn(process.execPath, [scriptPath, ...passthrough], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CAREERBOT_WORKSPACE_ROOT: ws.root,
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
