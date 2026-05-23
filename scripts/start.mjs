#!/usr/bin/env node

// Cross-platform launcher for the CataBull dashboard.
// Checks for dependencies, installs if needed, and starts the server.

import { existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { ensurePlaywrightChromium } from '../lib/runtime-deps.mjs';

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
const child = spawn(process.execPath, [serverPath], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env },
});

child.on('close', (code) => process.exit(code));

// Forward signals for clean shutdown
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
