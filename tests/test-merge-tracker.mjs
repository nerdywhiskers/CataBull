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

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
