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

const {
  resolveReportPath,
  archiveReportFile,
  inferTailorBundleFromReport,
  collectReportExportEntries,
  buildReportExportZip,
} = await import(
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

const inferredBundle = inferTailorBundleFromReport(`
[CV PDF](/api/v1/tailor/file?path=output%2Ftailor-bundles%2Facme-role-2026-06-08%2Fcv.pdf)
[CV MD](/api/v1/tailor/file?path=output%2Ftailor-bundles%2Facme-role-2026-06-08%2Fcv.md)
[Cover PDF](/api/v1/tailor/file?path=output%2Ftailor-bundles%2Facme-role-2026-06-08%2Fcover-letter.pdf)
[Cover MD](/api/v1/tailor/file?path=output%2Ftailor-bundles%2Facme-role-2026-06-08%2Fcover-letter.md)
[Q&A](/api/v1/tailor/file?path=output%2Ftailor-bundles%2Facme-role-2026-06-08%2Fanswers.md)
`);
assert(inferredBundle?.dir === 'output/tailor-bundles/acme-role-2026-06-08', 'inferTailorBundleFromReport extracts bundle dir');
assert(inferredBundle?.paths?.cvPdf === 'output/tailor-bundles/acme-role-2026-06-08/cv.pdf', 'inferTailorBundleFromReport extracts CV PDF path');
assert(inferredBundle?.paths?.coverLetter === 'output/tailor-bundles/acme-role-2026-06-08/cover-letter.md', 'inferTailorBundleFromReport extracts cover letter markdown path');
assert(inferredBundle?.paths?.qa === 'output/tailor-bundles/acme-role-2026-06-08/answers.md', 'inferTailorBundleFromReport extracts Q&A path');

const inferredFromDir = inferTailorBundleFromReport('Bundle directory: `output/tailor-bundles/acme-role-2026-06-08`');
assert(inferredFromDir?.paths?.coverLetterPdf === 'output/tailor-bundles/acme-role-2026-06-08/cover-letter.pdf', 'inferTailorBundleFromReport expands bundle directory into PDF paths');

const inferredLegacyCv = inferTailorBundleFromReport(
  '**Tailored CV:** output/tailor-bundles/legacy-role-2026-06-08/tailored-cv.md'
);
assert(
  inferredLegacyCv?.paths?.cv === 'output/tailor-bundles/legacy-role-2026-06-08/tailored-cv.md',
  'inferTailorBundleFromReport exposes legacy tailored-cv.md as the CV artifact'
);

const exportRoot = join(ROOT, '.tmp-test-report-export');
mkdirSync(join(exportRoot, 'reports'), { recursive: true });
mkdirSync(join(exportRoot, 'output', 'tailor-bundles', 'acme-role-2026-06-08'), { recursive: true });
writeFileSync(join(exportRoot, 'reports', '002-acme-2026-06-08.md'), '# report\n');
writeFileSync(join(exportRoot, 'output', 'cv-acme-2026-06-08.pdf'), 'pdf');
writeFileSync(join(exportRoot, 'output', 'tailor-bundles', 'acme-role-2026-06-08', 'cv.md'), '# tailored cv\n');
writeFileSync(join(exportRoot, 'output', 'tailor-bundles', 'acme-role-2026-06-08', 'cover-letter.md'), '# cover\n');

const exportEntries = collectReportExportEntries(exportRoot, '002-acme-2026-06-08.md', {
  artifacts: [{ path: 'output/cv-acme-2026-06-08.pdf' }],
  tailorBundle: { paths: {
    cv: 'output/tailor-bundles/acme-role-2026-06-08/cv.md',
    coverLetter: 'output/tailor-bundles/acme-role-2026-06-08/cover-letter.md',
  } },
});
assert(exportEntries.length === 4, 'collectReportExportEntries gathers report, artifacts, and tailor bundle files');

const zip = await buildReportExportZip(exportRoot, '002-acme-2026-06-08.md', {
  artifacts: [{ path: 'output/cv-acme-2026-06-08.pdf' }],
  tailorBundle: { paths: {
    cv: 'output/tailor-bundles/acme-role-2026-06-08/cv.md',
    coverLetter: 'output/tailor-bundles/acme-role-2026-06-08/cover-letter.md',
  } },
});
assert(Buffer.isBuffer(zip?.buffer), 'buildReportExportZip returns zip buffer');
assert(zip?.entries?.some((entry) => entry.zipPath === 'report/002-acme-2026-06-08.md'), 'zip includes report markdown');
assert(zip?.entries?.some((entry) => entry.zipPath === 'artifacts/cv-acme-2026-06-08.pdf'), 'zip includes artifact files');
assert(zip?.entries?.some((entry) => entry.zipPath === 'tailor-bundle/cover-letter.md'), 'zip includes tailor bundle files');

rmSync(tmpRoot, { recursive: true, force: true });
rmSync(exportRoot, { recursive: true, force: true });

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
