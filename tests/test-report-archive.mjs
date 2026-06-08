#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, msg) {
  total++;
  if (condition) passed++;
  else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nreport archive helpers');

const { resolveReportPath, archiveReportFile } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/routes/reports.mjs')).href
);

const tmpRoot = join(ROOT, '.tmp-test-report-archive');
const reportsDir = join(tmpRoot, 'reports');
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, '001-acme-2026-06-08.md'), '# test\n');

const active = resolveReportPath(tmpRoot, '001-acme-2026-06-08.md');
assert(active?.archived === false, 'active report resolves from reports dir');

const archived = archiveReportFile(tmpRoot, '001-acme-2026-06-08.md');
assert(archived?.archived === true, 'archiveReportFile marks archived');
assert(existsSync(join(tmpRoot, 'reports', 'archive', '001-acme-2026-06-08.md')), 'archived report moved into reports/archive');

const resolvedArchived = resolveReportPath(tmpRoot, '001-acme-2026-06-08.md');
assert(resolvedArchived?.archived === true, 'resolveReportPath finds archived reports after move');
assert(archiveReportFile(tmpRoot, 'missing.md') === null, 'archiving missing report returns null');

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
