#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`❌ ${message}`);
  }
}

const { computeProgressMetrics } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'metrics.mjs')).href
);

const metrics = computeProgressMetrics([
  { status: 'Applied', score: 4.2, date: '2026-07-01' },
  { status: 'Responded', score: 3.8, date: '2026-07-02' },
  { status: 'Interview', score: 4.5, date: '2026-07-03' },
  { status: 'Offer', score: 4.9, date: '2026-07-04' },
  { status: 'Rejected', score: 2.7, date: '2026-07-05' },
  { status: 'Tailored', score: 3.1, date: '2026-07-06' },
]);

const rejectedStage = metrics.funnelStages.find((stage) => stage.label === 'Rejected');
assert(Boolean(rejectedStage), 'progress metrics include a rejected funnel stage');
assert(rejectedStage?.count === 1, 'rejected funnel stage counts rejected applications');
assert(Math.abs((rejectedStage?.pct || 0) - 20) < 0.001, 'rejected funnel stage uses rejected/applied percentage');
assert(metrics.rejectedCount === 1, 'progress metrics expose rejected count');
assert(Math.abs(metrics.rejectionRate - 20) < 0.001, 'progress metrics expose rejection rate as rejected/applied');
assert(Math.abs(metrics.responseRate - 60) < 0.001, 'response rate still uses responded/applied');
assert(Math.abs(metrics.offerRate - 20) < 0.001, 'offer rate still uses offer/applied');

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`metrics: ${passed} passed`);
