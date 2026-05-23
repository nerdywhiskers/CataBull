#!/usr/bin/env node

import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { listCvFiles, resolveCvPath } from '../dashboard-web/routes/cv.mjs';

const root = mkdtempSync(join(tmpdir(), 'catabull-cv-route-test-'));

try {
  writeFileSync(join(root, 'cv.md'), '# Master CV\n');
  mkdirSync(join(root, 'output'), { recursive: true });
  writeFileSync(join(root, 'output', 'cv-demo-role-2026-05-17.md'), '# Demo CV\n');
  writeFileSync(join(root, 'output', 'cv-demo-role-2026-05-17.pdf'), '%PDF');
  writeFileSync(join(root, 'output', 'cv-demo-role-2026-05-17.html'), '<html></html>');
  writeFileSync(join(root, 'output', 'notes.md'), 'ignore me');

  mkdirSync(join(root, 'output', 'tailor-bundles', 'acme-engineer-2026-05-17'), { recursive: true });
  writeFileSync(join(root, 'output', 'tailor-bundles', 'acme-engineer-2026-05-17', 'cv.md'), '# Bundle CV\n');
  writeFileSync(join(root, 'output', 'tailor-bundles', 'acme-engineer-2026-05-17', 'answers.md'), '# Answers\n');

  const cvs = listCvFiles(root);
  assert.equal(cvs[0].path, 'cv.md');
  assert.equal(cvs[0].downloadMdPath, 'cv.md');

  const generated = cvs.find(c => c.name === 'cv-demo-role-2026-05-17');
  assert.ok(generated);
  assert.equal(generated.path, 'output/cv-demo-role-2026-05-17.md');
  assert.deepEqual(generated.formats, ['md', 'pdf', 'html']);
  assert.equal(generated.downloadMdPath, 'output/cv-demo-role-2026-05-17.md');
  assert.equal(generated.downloadPdfPath, 'output/cv-demo-role-2026-05-17.pdf');
  assert.equal(generated.downloadHtmlPath, 'output/cv-demo-role-2026-05-17.html');

  const bundled = cvs.find(c => c.source === 'tailor-bundle');
  assert.ok(bundled);
  assert.equal(bundled.name, 'acme-engineer-2026-05-17 (tailor bundle)');
  assert.equal(bundled.path, 'output/tailor-bundles/acme-engineer-2026-05-17/cv.md');
  assert.equal(bundled.downloadMdPath, bundled.path);
  assert.deepEqual(bundled.formats, ['md']);

  assert.equal(resolveCvPath(root, 'cv.md').ok, true);
  assert.equal(resolveCvPath(root, 'output/cv-demo-role-2026-05-17.pdf').ok, true);
  assert.equal(resolveCvPath(root, 'output/tailor-bundles/acme-engineer-2026-05-17/cv.md').ok, true);
  assert.equal(resolveCvPath(root, 'output/tailor-bundles/acme-engineer-2026-05-17/answers.md').ok, false);
  assert.equal(resolveCvPath(root, '../cv.md').ok, false);

  console.log('\ndashboard CV route');
  console.log('  ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
