#!/usr/bin/env node

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Fastify from 'fastify';
import applicationsRoute from '../dashboard-web/routes/applications.mjs';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed++;
  else { failed++; console.log(`  ❌ ${message}`); }
}

console.log('\napplications GET is read-only');

const root = mkdtempSync(join(tmpdir(), 'catabull-applications-read-test-'));
const server = Fastify();
try {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-08-05 | Acme | Designer | 4.0/5 | Tailored | ❌ | | |\n');
  const pipelinePath = join(root, 'data', 'pipeline.md');
  const originalPipeline = '# Pipeline\n\n- [ ] https://jobs.test/acme | Acme | Designer\n';
  writeFileSync(pipelinePath, originalPipeline);

  server.decorate('cataBullRoot', root);
  await server.register(applicationsRoute);
  const response = await server.inject({ method: 'GET', url: '/applications' });
  const body = response.json();

  assert(response.statusCode === 200, 'GET /applications succeeds');
  assert(body.pendingTotal === 0, 'GET filters already-tracked roles from response');
  assert(readFileSync(pipelinePath, 'utf8') === originalPipeline, 'GET does not rewrite pipeline state');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`Passed: ${passed} / ${passed + failed}`);
if (failed) process.exit(1);
