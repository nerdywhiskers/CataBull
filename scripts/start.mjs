#!/usr/bin/env node

// Cross-platform launcher for the CataBull dashboard.
// Checks for dependencies, installs if needed, and starts the server.

import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { ensurePlaywrightChromium } from '../lib/runtime-deps.mjs';
import { DEFAULT_RESTART_EXIT_CODE } from '../dashboard-web/lib/restart-control.mjs';

const __dirname = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(__dirname, 'node_modules');
const serverPath = join(__dirname, 'dashboard-web', 'server.mjs');

// Check Node version
const [major] = process.version.slice(1).split('.').map(Number);
if (major < 18) {
  console.error(`\n  Node.js 18+ required (you have ${process.version})\n  Download: https://nodejs.org\n`);
  process.exit(1);
}

// Install dependencies if needed
if (!existsSync(join(nodeModules, 'fastify')) || !existsSync(join(nodeModules, '@fastify', 'static'))) {
  console.log('\n  Installing dependencies...\n');
  try {
    execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
  } catch {
    console.error('\n  Failed to install dependencies. Run "npm install" manually.\n');
    process.exit(1);
  }
}

const browser = await ensurePlaywrightChromium({
  cwd: __dirname,
  logger: console,
  install: true,
});
if (!browser.ok && browser.reason !== 'missing-playwright') {
  console.error(`\n  ${browser.message}\n`);
  process.exit(1);
}

// Start the dashboard
console.log('\n  Starting CataBull dashboard...\n');
let child = null;

function startChild() {
  return spawn(process.execPath, [serverPath], {
    cwd: __dirname,
    stdio: 'inherit',
    env: {
      ...process.env,
      CATABULL_LAUNCHER: 'start-script',
      CATABULL_RESTART_SUPPORTED: 'true',
      CATABULL_RESTART_EXIT_CODE: String(DEFAULT_RESTART_EXIT_CODE),
    },
  });
}

function launch() {
  child = startChild();
  child.on('close', (code) => {
    if (code === DEFAULT_RESTART_EXIT_CODE) {
      console.log('\n  Restarting CataBull dashboard...\n');
      launch();
      return;
    }
    process.exit(code ?? 0);
  });
}

launch();

// Forward signals for clean shutdown
process.on('SIGINT', () => child?.kill('SIGINT'));
process.on('SIGTERM', () => child?.kill('SIGTERM'));
