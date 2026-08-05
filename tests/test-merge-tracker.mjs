#!/usr/bin/env node

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)).replace(/^file:\/\//, ''));

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

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'catabull-merge-tracker-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'batch', 'tracker-additions'), { recursive: true });
  return dir;
}

function runMergeTracker(workspace) {
  return spawnSync('node', [join(ROOT, 'merge-tracker.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CATABULL_WORKSPACE_ROOT: workspace },
    encoding: 'utf8',
  });
}

function runDedupTracker(workspace) {
  return spawnSync('node', [join(ROOT, 'dedup-tracker.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CATABULL_WORKSPACE_ROOT: workspace },
    encoding: 'utf8',
  });
}

function runNormalizeStatuses(workspace) {
  return spawnSync('node', [join(ROOT, 'normalize-statuses.mjs')], {
    cwd: ROOT,
    env: { ...process.env, CATABULL_WORKSPACE_ROOT: workspace },
    encoding: 'utf8',
  });
}

function runAnalyzePatterns(workspace, minThreshold = 1) {
  return spawnSync('node', [join(ROOT, 'analyze-patterns.mjs'), '--min-threshold', String(minThreshold)], {
    cwd: ROOT,
    env: { ...process.env, CATABULL_WORKSPACE_ROOT: workspace },
    encoding: 'utf8',
  });
}

console.log('\nmerge-tracker');

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`);
    writeFileSync(join(workspace, 'batch', 'tracker-additions', '001.tsv'), '1\t2026-06-24\tAutodesk\tSenior Art Director/Designer - Flow Studio\tTailored\t3.6/5\tno\t[015](reports/015-autodesk-2026-06-24.md)\tFresh tailor\n');

    const result = runMergeTracker(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'merge-tracker exits 0 for Tailored TSV addition');
    assert(content.includes('| 1 | 2026-06-24 | Autodesk | Senior Art Director/Designer - Flow Studio | 3.6/5 | Tailored | no | [015](reports/015-autodesk-2026-06-24.md) | Fresh tailor |'), 'new Tailored tracker additions stay Tailored when merged');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-03 | NewCo | Senior Product Designer | 4.4/5 | Applied | ❌ | [0007](reports/0007-old.md) | |\n`);
    writeFileSync(join(workspace, 'batch', 'tracker-additions', '0007.tsv'), '1\t2026-06-04\tNewCo\tSenior Product Designer\tTailored\t4.7/5\t✅\t[0007](reports/0007-new.md)\tRefreshed\n');

    const result = runMergeTracker(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'merge-tracker exits 0 for duplicate Tailored TSV update');
    assert(content.includes('| 1 | 2026-06-04 | NewCo | Senior Product Designer | 4.7/5 | Applied | ❌ | [0007](reports/0007-new.md) | Re-eval 2026-06-04 (4.4→4.7). Refreshed |'), 'duplicate Tailored additions preserve existing Applied status');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 12 | 2026-06-18 | Google | Designer, Creative Lab | 3.4/5 | Rejected | ❌ | [012](reports/012-google-old.md) | Prior rejection |\n`);
    writeFileSync(join(workspace, 'batch', 'tracker-additions', '012.tsv'), '12\t2026-06-18\tGoogle\tDesigner, Creative Lab\tTailored\t3.4/5\t❌\t[012](reports/012-google-2026-06-18.md)\tFresh tailor rerun\n');

    const result = runMergeTracker(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'merge-tracker exits 0 for duplicate Tailored TSV re-merge over Rejected row');
    assert(content.includes('| 12 | 2026-06-18 | Google | Designer, Creative Lab | 3.4/5 | Rejected | ❌ | [012](reports/012-google-old.md) | Prior rejection |'), 'duplicate Tailored additions do not downgrade existing Rejected status when score is unchanged');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-01 | BMW Group | Visualizer | 3.5/5 | Tailored | ❌ | [001](reports/001-bmw.md) | |\n`);
    writeFileSync(join(workspace, 'batch', 'tracker-additions', '002.tsv'), '2\t2026-06-02\tBMW Group, Inc.\tVisualizer\tTailored\t3.6/5\t❌\t[002](reports/002-bmw.md)\tRefresh\n');

    const result = runMergeTracker(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'merge-tracker exits 0 for a single-word duplicate role');
    assert((content.match(/\| Visualizer \|/g) || []).length === 1, 'merge-tracker merges exact single-word roles across company suffix variants');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`);
    writeFileSync(join(workspace, 'batch', 'tracker-additions', '007.tsv'), '7\t2026-06-01\tAcme\tDesigner\tTailored\t4.0/5\t❌\t[007](reports/007-acme.md)\tFirst\n');
    writeFileSync(join(workspace, 'batch', 'tracker-additions', '008.tsv'), '8\t2026-06-02\tAcme, Inc.\tDesigner\tTailored\t4.1/5\t❌\t[008](reports/008-acme.md)\tSecond\n');

    const result = runMergeTracker(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'merge-tracker exits 0 for duplicate additions in one batch');
    assert((content.match(/\| Designer \|/g) || []).length === 1, 'merge-tracker updates its identity index after accepting a fresh addition');
    assert(content.includes('4.1/5'), 'merge-tracker keeps the stronger duplicate addition from the same batch');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-01 | BMW Group | Visualizer | 3.5/5 | Tailored | ❌ | [001](reports/001-bmw.md) | first |\n| 2 | 2026-06-02 | BMW Group, Inc. | Visualizer | 3.6/5 | Applied | ❌ | [002](reports/002-bmw.md) | second |\n`);

    const result = runDedupTracker(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'dedup-tracker exits 0 for exact single-word duplicate roles');
    assert((content.match(/\| Visualizer \|/g) || []).length === 1, 'dedup-tracker removes exact single-word duplicates across company suffix variants');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`);
    writeFileSync(join(workspace, 'batch', 'tracker-additions', '001.tsv'), '1\t2026-06-01\tLegacyCo\tLegacy Role\tEvaluated\t3.5/5\t❌\t[001](reports/001-legacy.md)\tLegacy status\n');

    const result = runMergeTracker(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'merge-tracker accepts legacy Evaluated additions');
    assert(content.includes('| Tailored |'), 'merge-tracker writes legacy Evaluated additions as canonical Tailored');
    assert(!content.includes('| Evaluated |'), 'merge-tracker does not persist the legacy Evaluated alias');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-01 | LegacyCo | Legacy Role | 3.5/5 | Evaluated | ❌ | [001](reports/001-legacy.md) | |\n| 2 | 2026-06-02 | ModernCo | Modern Role | 4.0/5 | Tailored | ❌ | [002](reports/002-modern.md) | |\n`);

    const result = runNormalizeStatuses(workspace);
    const content = readFileSync(join(workspace, 'data', 'applications.md'), 'utf8');

    assert(result.status === 0, 'normalize-statuses exits 0 for legacy and canonical tailored states');
    assert((content.match(/\| Tailored \|/g) || []).length === 2, 'normalize-statuses converts Evaluated to Tailored and preserves Tailored');
    assert(!result.stdout.includes('unknown statuses'), 'normalize-statuses recognizes Tailored as canonical');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

{
  const workspace = makeWorkspace();
  try {
    writeFileSync(join(workspace, 'data', 'applications.md'), `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-06-01 | PendingCo | Pending Role | 3.5/5 | Tailored | ❌ | | |\n`);

    const result = runAnalyzePatterns(workspace, 1);
    const payload = JSON.parse(result.stdout || '{}');

    assert(result.status === 1, 'analyze-patterns returns its documented insufficient-data exit when only Tailored roles exist');
    assert(payload.current === 0 && payload.threshold === 1, 'analyze-patterns excludes canonical Tailored roles from progressed outcomes');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
