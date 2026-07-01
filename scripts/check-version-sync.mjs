#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const fileVersion = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();

if (!/^\d+\.\d+\.\d+$/.test(pkg.version || '')) {
  console.error(`package.json version is not valid semver: ${pkg.version}`);
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(fileVersion)) {
  console.error(`VERSION is not valid semver: ${fileVersion}`);
  process.exit(1);
}

if (pkg.version !== fileVersion) {
  console.error(`Version mismatch: package.json=${pkg.version} VERSION=${fileVersion}`);
  process.exit(1);
}

console.log(`Version sync OK: ${pkg.version}`);
