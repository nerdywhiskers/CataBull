#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

console.log('\nPipeline writer helpers');

const { markPipelineTailored, updatePendingContextualScores, updatePendingItem } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'writers.mjs')).href
);
const { parsePipeline } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'parsers.mjs')).href
);

const tmpRoot = join(ROOT, '.tmp-test-pipeline-writers');
mkdirSync(join(tmpRoot, 'data'), { recursive: true });
writeFileSync(join(tmpRoot, 'data', 'pipeline.md'), `# Pipeline\n\n## Pendientes\n- [ ] https://example.com/jobs/1 | OldCo | Old Role | posted:2026-06-01 | loc:Remote | match:high\n- [x] https://example.com/jobs/2 | SkippedCo | Skip Role | SKIP | 2026-06-02\n\n## Procesadas\n`);

const result = updatePendingItem(tmpRoot, {
  url: 'https://example.com/jobs/1',
  company: 'NewCo',
  role: 'Senior Product Designer',
  postedAt: '2026-06-03',
  location: 'Los Angeles',
});
assert(result.updated === true, 'updates existing pending row');

const updated = readFileSync(join(tmpRoot, 'data', 'pipeline.md'), 'utf8');
assert(updated.includes('- [ ] https://example.com/jobs/1 | NewCo | Senior Product Designer | posted:2026-06-03 | loc:Los Angeles | match:high'), 'preserves extra metadata while updating pending row');
assert(updated.includes('https://example.com/jobs/2 | SkippedCo | Skip Role | SKIP | 2026-06-02'), 'does not rewrite skipped rows');

const scored = updatePendingContextualScores(tmpRoot, [{
  id: 'https://example.com/jobs/1',
  score: 4.37,
  rationale: 'Strong creative technology fit | with unsafe pipe',
  signals: ['AI prototypes', 'Art direction'],
}]);
assert(scored.updated === 1, 'persists contextual score metadata on pending row');
const parsed = parsePipeline(tmpRoot).pending[0];
assert(parsed.contextualScore === 4.4, 'parsePipeline reads persisted contextual score');
assert(parsed.contextualScoreSource === 'llm', 'parsePipeline marks persisted contextual score source');
assert(parsed.contextualRationale === 'Strong creative technology fit with unsafe pipe', 'parsePipeline reads sanitized contextual rationale');
assert(parsed.contextualSignals?.[0] === 'AI prototypes', 'parsePipeline reads contextual signals');

const missing = updatePendingItem(tmpRoot, {
  url: 'https://example.com/jobs/missing',
  company: 'Ghost',
  role: 'Ghost Role',
});
assert(missing.updated === false, 'missing pending row returns not updated');
assert(missing.error === 'pending item not found', 'missing pending row returns explicit error');

const tailored = markPipelineTailored(tmpRoot, {
  url: 'https://example.com/jobs/1',
  company: 'NewCo',
  role: 'Senior Product Designer',
  reportPath: 'reports/0007-newco-senior-product-designer.md',
  reportNumber: '0007',
  hasPdf: true,
  scoreRaw: '4.4/5',
});
assert(tailored.success === true, 'markPipelineTailored succeeds for existing pending rows');

const pipelineAfterTailor = readFileSync(join(tmpRoot, 'data', 'pipeline.md'), 'utf8');
assert(pipelineAfterTailor.includes('- [x] https://example.com/jobs/1 | NewCo | Senior Product Designer'), 'markPipelineTailored marks the pending pipeline row done');

const appsPath = join(tmpRoot, 'applications.md');
const tailoredApps = readFileSync(appsPath, 'utf8');
assert(tailoredApps.includes('| 1 | '), 'markPipelineTailored bootstraps applications tracker rows');
assert(tailoredApps.includes('| NewCo | Senior Product Designer | 4.4/5 | Tailored | ✅ | [0007](reports/0007-newco-senior-product-designer.md) |'), 'markPipelineTailored writes Tailored status, PDF state, and report link');

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
