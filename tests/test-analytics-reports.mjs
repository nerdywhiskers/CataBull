#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nanalytics reports routing');

globalThis.window = { location: { hash: '' } };
globalThis.document = { getElementById() { return null; } };

const { normalizeAnalyticsSubTab } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/public/js/views/progress.mjs')).href
);
const { computeProgressMetrics } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/lib/metrics.mjs')).href
);

const overview = normalizeAnalyticsSubTab('');
assert(overview.tab === 'overview' && overview.reportFilename === '', 'empty subtab resolves to overview');

const reportsRoot = normalizeAnalyticsSubTab('reports');
assert(reportsRoot.tab === 'reports' && reportsRoot.reportFilename === '', 'reports subtab resolves to reports list');

const reportsDetail = normalizeAnalyticsSubTab('reports/123-acme-2026-06-08.md');
assert(
  reportsDetail.tab === 'reports' && reportsDetail.reportFilename === '123-acme-2026-06-08.md',
  'reports detail subtab preserves filename',
);

const reportsEncoded = normalizeAnalyticsSubTab(`reports/${encodeURIComponent('123-acme 2026.md')}`);
assert(
  reportsEncoded.tab === 'reports' && reportsEncoded.reportFilename === '123-acme 2026.md',
  'reports detail subtab decodes encoded filename',
);

const memory = normalizeAnalyticsSubTab('memory');
assert(memory.tab === 'memory' && memory.reportFilename === '', 'memory subtab resolves correctly');

const fallback = normalizeAnalyticsSubTab('wat');
assert(fallback.tab === 'overview', 'unknown subtab falls back to overview');

const metrics = computeProgressMetrics([
  { status: 'Applied', score: 4.2, date: '2026-06-01' },
  { status: 'Rejected', score: 3.9, date: '2026-06-02' },
  { status: 'Interview', score: 4.8, date: '2026-06-03' },
  { status: 'Offer', score: 4.9, date: '2026-06-04' },
]);
assert(metrics.rejectedCount === 1, 'progress metrics expose rejected count');
assert(metrics.interviewRate > 0, 'progress metrics still compute interview rate');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
