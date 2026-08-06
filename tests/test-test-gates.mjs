#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed++;
  else { failed++; console.log(`  ❌ ${message}`); }
}

console.log('\ncomprehensive test-gate contract');

for (const command of ['test:repo', 'test:unit', 'test:security', 'test:frontend', 'test:all', 'check:syntax']) {
  assert(Boolean(pkg.scripts?.[command]), `package exposes ${command}`);
}
for (const command of ['test:repo', 'test:unit', 'test:security', 'test:frontend', 'check:syntax']) {
  assert(pkg.scripts?.['test:all']?.includes(`npm run ${command}`), `test:all includes ${command}`);
}
assert(pkg.scripts?.['test:unit']?.includes('tests/test-scheduler.mjs'), 'unit gate includes scheduler regression');
assert(pkg.scripts?.['test:unit']?.includes('tests/test-applications-readonly.mjs'), 'unit gate includes read-only applications regression');
assert(pkg.scripts?.['test:security']?.includes('tests/run-isolated.mjs'), 'security gate uses isolated workspace wrapper');
assert(pkg.scripts?.['test:frontend']?.includes('tests/run-isolated.mjs'), 'frontend gate uses isolated workspace wrapper');

for (const workflow of ['test.yml', 'frontend-smoke.yml', 'security-regression.yml']) {
  const raw = readFileSync(resolve(root, '.github', 'workflows', workflow), 'utf8');
  assert(/branches:\s*\[dev, main\]/.test(raw), `${workflow} runs for dev and main PRs`);
}

console.log(`Passed: ${passed} / ${passed + failed}`);
if (failed) process.exit(1);
