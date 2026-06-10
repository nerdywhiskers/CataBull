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
const { extractReportSections, reportPostingUrl } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/public/js/views/reports.mjs')).href
);
const { hydrateTailorBundle } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/routes/reports.mjs')).href
);
const { computeProgressMetrics } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/lib/metrics.mjs')).href
);
const { LocalWorkspace } = await import(
  pathToFileURL(join(ROOT, 'lib/workspace.mjs')).href
);
const { mkdtempSync, rmSync } = await import('fs');
const { tmpdir } = await import('os');

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

const reportSections = extractReportSections(`# Title\n\n## TL;DR\nbody\n\n## A) Match With CV - 4.4/5\nbody\n\n## TL;DR\nrepeat`);
assert(reportSections.length === 2, 'extractReportSections dedupes repeated headings');
assert(reportSections[0].id === 'tl-dr', 'extractReportSections slugifies heading ids');
assert(reportSections[1].id === 'a-match-with-cv-4-4-5', 'extractReportSections keeps stable ids for score headings');
assert(reportPostingUrl('**URL:** https://example.com/jobs/123\n') === 'https://example.com/jobs/123', 'reportPostingUrl extracts posting link from report body');

const tmp = mkdtempSync(join(tmpdir(), 'catabull-reports-test-'));
const ws = new LocalWorkspace(tmp);
ws.write('output/tailor-bundles/acme-2026-06-10/cv.md', '# CV\n\nPreview body');
const hydratedBundle = hydrateTailorBundle(tmp, {
  dir: 'output/tailor-bundles/acme-2026-06-10',
  paths: {
    cv: 'output/tailor-bundles/acme-2026-06-10/cv.md',
    qa: 'output/tailor-bundles/acme-2026-06-10/answers.md',
  },
});
assert(hydratedBundle.paths.cv, 'hydrateTailorBundle preserves existing bundle files');
assert(!hydratedBundle.paths.qa, 'hydrateTailorBundle drops non-existent QA files instead of surfacing dead links');
assert(hydratedBundle.previews.cv.includes('Preview body'), 'hydrateTailorBundle includes markdown previews for existing files');
rmSync(tmp, { recursive: true, force: true });

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
