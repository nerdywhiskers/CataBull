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

const { markPipelineTailored, updatePendingContextualScores, updatePendingItem, enforcePipelineConsistency, canonicalCompanyRoleKey, updateApplicationStatus, markPipelineApplied } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'writers.mjs')).href
);
const { parsePipeline, parseApplications, parseApplicationEvents } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'parsers.mjs')).href
);

const tmpRoot = join(ROOT, '.tmp-test-pipeline-writers');
mkdirSync(join(tmpRoot, 'data'), { recursive: true });
writeFileSync(join(tmpRoot, 'data', 'pipeline.md'), `# Pipeline\n\n## Pendientes\n- [ ] https://example.com/jobs/1 | OldCo | Old Role | posted:2026-06-01 | loc:Remote | match:high\n- [x] https://example.com/jobs/2 | SkippedCo | Skip Role | SKIP | 2026-06-02\n\n## Procesadas\n`);

writeFileSync(join(tmpRoot, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 25 | 2026-06-01 | Wrong Row | Wrong Role | 2.0/5 | Applied | ❌ |  | |\n| 7 | 2026-06-08 | Adobe | Creative Technologist, Media & Entertainment |  | Applied | ❌ |  | |\n`);

const statusUpdatedByTrackerId = updateApplicationStatus(tmpRoot, '', 25, 'Rejected', 7);
assert(statusUpdatedByTrackerId === true, 'status update accepts a stable tracker row id when report link is missing');
const appsAfterTrackerIdUpdate = readFileSync(join(tmpRoot, 'data', 'applications.md'), 'utf8');
assert(appsAfterTrackerIdUpdate.includes('| 7 | 2026-06-08 | Adobe | Creative Technologist, Media & Entertainment |  | Rejected | ❌ |  | |'), 'status update changes the intended tracker row without report link');
assert(appsAfterTrackerIdUpdate.includes('| 25 | 2026-06-01 | Wrong Row | Wrong Role | 2.0/5 | Applied | ❌ |  | |'), 'status update leaves unrelated row numbers untouched when parse-order num differs from tracker id');
const statusEvents = parseApplicationEvents(tmpRoot);
assert(statusEvents.some((event) => event.trackerRowId === 7 && event.event === 'rejected'), 'status update appends an event log row for the new status');
rmSync(join(tmpRoot, 'data', 'applications.md'), { force: true });
rmSync(join(tmpRoot, 'data', 'application-events.tsv'), { force: true });

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
let applicationEvents = parseApplicationEvents(tmpRoot);
assert(applicationEvents.some((event) => event.trackerRowId === 1 && event.event === 'tailored'), 'markPipelineTailored appends a tailored event for new tracked rows');

writeFileSync(appsPath, `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-03 | NewCo | Senior Product Designer | 4.4/5 | Applied | ❌ | [0007](reports/0007-newco-senior-product-designer.md) | |\n`);
const preserved = markPipelineTailored(tmpRoot, {
  url: 'https://example.com/jobs/1',
  company: 'NewCo',
  role: 'Senior Product Designer',
  reportPath: 'reports/0007-newco-senior-product-designer-v2.md',
  reportNumber: '0007',
  hasPdf: true,
  scoreRaw: '4.7/5',
});
assert(preserved.success === true, 'markPipelineTailored still succeeds when a stronger application status already exists');
const preservedApps = readFileSync(appsPath, 'utf8');
assert(
  preservedApps.includes('| NewCo | Senior Product Designer | 4.7/5 | Applied | ✅ | [0007](reports/0007-newco-senior-product-designer-v2.md) |'),
  'markPipelineTailored preserves Applied instead of regressing back to Tailored while still refreshing score/pdf/report fields'
);
applicationEvents = parseApplicationEvents(tmpRoot);
assert(applicationEvents.filter((event) => event.trackerRowId === 1 && event.event === 'tailored').length === 1, 'markPipelineTailored does not append a fresh tailored event when a stronger status is preserved');

writeFileSync(appsPath, `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-03 | NewCo | Senior Product Designer | 4.7/5 | Tailored | ✅ | [0007](reports/0007-newco-senior-product-designer-v2.md) | |\n`);
markPipelineApplied(tmpRoot, 'https://example.com/jobs/1', 'NewCo', 'Senior Product Designer');
applicationEvents = parseApplicationEvents(tmpRoot);
assert(applicationEvents.some((event) => event.trackerRowId === 1 && event.event === 'applied'), 'markPipelineApplied appends an applied event when an existing tracked row advances to Applied');
const parsedAppsWithEvents = parseApplications(tmpRoot);
assert(parsedAppsWithEvents[0].appliedAt === applicationEvents.find((event) => event.event === 'applied')?.date, 'parseApplications derives appliedAt from the first applied event');
assert(parsedAppsWithEvents[0].lastEventType === 'applied', 'parseApplications exposes the last recorded application event');

writeFileSync(appsPath, `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 10 | 2026-06-01 | WrongCo | Wrong Role | 4.0/5 | Tailored | ❌ | [0007](reports/0007-wrong.md) | |\n| 20 | 2026-06-02 | RightCo | Right Role | 4.1/5 | Tailored | ❌ | [0007](reports/0007-right.md) | |\n`);
const duplicateReportStatusUpdate = updateApplicationStatus(tmpRoot, '0007', 2, 'Applied', 20);
assert(duplicateReportStatusUpdate === true, 'status update succeeds when duplicate report numbers exist');
const duplicateReportApps = readFileSync(appsPath, 'utf8');
assert(duplicateReportApps.includes('| 10 | 2026-06-01 | WrongCo | Wrong Role | 4.0/5 | Tailored |'), 'stable tracker id prevents a duplicate report number from updating the wrong row');
assert(duplicateReportApps.includes('| 20 | 2026-06-02 | RightCo | Right Role | 4.1/5 | Applied |'), 'stable tracker id updates the intended row when report numbers collide');

writeFileSync(appsPath, `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-01 | FirstCo | First Role | | Applied | ❌ | | |\n| 3 | 2026-06-02 | ThirdCo | Third Role | | Applied | ❌ | | |\n`);
writeFileSync(join(tmpRoot, 'data', 'pipeline.md'), `# Pipeline\n\n## Pendientes\n- [ ] https://example.com/jobs/new-role | NewCo | New Role\n\n## Procesadas\n`);
markPipelineApplied(tmpRoot, 'https://example.com/jobs/new-role', 'NewCo', 'New Role');
const nonContiguousApps = readFileSync(appsPath, 'utf8');
assert(nonContiguousApps.includes('| 4 |') && nonContiguousApps.includes('| NewCo | New Role |'), 'new applied rows allocate max tracker id plus one');
assert((nonContiguousApps.match(/^\| 3 \|/gm) || []).length === 1, 'new applied rows do not reuse an existing tracker id after gaps');

mkdirSync(join(tmpRoot, 'data'), { recursive: true });
writeFileSync(join(tmpRoot, 'data', 'pipeline.md'), `# Pipeline\n\n## Pendientes\n- [ ] https://example.com/jobs/duplicate-1 | AMD, Inc. | AI Creative Technologist\n- [ ] https://example.com/jobs/duplicate-2 | AMD | AI Creative Technologist\n- [ ] https://example.com/jobs/unique | OtherCo | Design Engineer\n- [x] https://example.com/jobs/skipped | HiddenCo | Hidden Role | SKIP | 2026-06-06\n- [ ] https://example.com/jobs/skipped-dup | HiddenCo | Hidden Role\n\n## Procesadas\n`);
writeFileSync(appsPath, `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-03 | AMD | AI Creative Technologist | 4.4/5 | Applied | ❌ | [0007](reports/0007-old.md) | |\n`);
const cleanup = enforcePipelineConsistency(tmpRoot);
assert(cleanup.removed === 3, 'enforcePipelineConsistency removes pending rows already tracked or duplicated');
assert(cleanup.removedBecauseTracked === 3, 'enforcePipelineConsistency removes pending rows blocked by tracked application or skipped states');
assert(cleanup.removedBecauseDuplicatePending === 0, 'tracked-state cleanup wins before duplicate-pending cleanup when a stronger status already exists');
const cleanedPipeline = readFileSync(join(tmpRoot, 'data', 'pipeline.md'), 'utf8');
assert(!cleanedPipeline.includes('https://example.com/jobs/duplicate-1'), 'cleanup removes pending rows that already exist as tracked applications');
assert(!cleanedPipeline.includes('https://example.com/jobs/duplicate-2'), 'cleanup removes same-role pending duplicates once a stronger tracked state exists');
assert(cleanedPipeline.includes('https://example.com/jobs/unique | OtherCo | Design Engineer'), 'cleanup keeps unrelated pending rows');
assert(!cleanedPipeline.includes('https://example.com/jobs/skipped-dup'), 'cleanup removes pending rows when the same role is already skipped');
assert(canonicalCompanyRoleKey('AMD, Inc.', 'AI Creative Technologist') === canonicalCompanyRoleKey('AMD', 'AI Creative Technologist'), 'canonicalCompanyRoleKey normalizes punctuation and suffix noise');

writeFileSync(join(tmpRoot, 'data', 'pipeline.md'), `# Pipeline\n\n## Pendientes\n- [ ] https://example.com/jobs/dupe-a | FreshCo | Product Designer\n- [ ] https://example.com/jobs/dupe-b | FreshCo | Product Designer\n- [ ] https://example.com/jobs/dupe-c | FreshCo | Product Designer\n\n## Procesadas\n`);
writeFileSync(appsPath, `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`);
const duplicateOnlyCleanup = enforcePipelineConsistency(tmpRoot);
assert(duplicateOnlyCleanup.removed === 2, 'enforcePipelineConsistency removes extra duplicate pending rows even without tracked applications');
assert(duplicateOnlyCleanup.removedBecauseTracked === 0, 'duplicate-only cleanup does not mislabel rows as tracked');
assert(duplicateOnlyCleanup.removedBecauseDuplicatePending === 2, 'duplicate-only cleanup keeps the first pending row and removes the rest');

rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
