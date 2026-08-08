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

  writeFileSync(pipelinePath, '# Pipeline\n\n- [ ] https://jobs.test/skip-me | OtherCo | Other Role\n');
  const skipResponse = await server.inject({
    method: 'POST',
    url: '/pipeline/skip',
    payload: { url: 'https://jobs.test/skip-me' },
  });
  assert(skipResponse.statusCode === 200, 'POST /pipeline/skip completes without a route exception');
  assert(skipResponse.json().success === true, 'POST /pipeline/skip reports the mutation succeeded');

  const statusResponse = await server.inject({
    method: 'PATCH',
    url: '/applications/1',
    payload: { status: 'SKIP' },
  });
  assert(statusResponse.statusCode === 200, 'PATCH /applications/:num completes without a route exception');
  assert(statusResponse.json().success === true, 'PATCH /applications/:num reports the mutation succeeded');

  writeFileSync(pipelinePath, '# Pipeline\n\n- [ ] https://jobs.test/apply-me | ApplyCo | Apply Role\n');
  const applyResponse = await server.inject({
    method: 'POST',
    url: '/pipeline/apply',
    payload: { url: 'https://jobs.test/apply-me', company: 'ApplyCo', role: 'Apply Role' },
  });
  assert(applyResponse.statusCode === 200, 'POST /pipeline/apply completes without a route exception');
  assert(applyResponse.json().success === true, 'POST /pipeline/apply reports the mutation succeeded');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`Passed: ${passed} / ${passed + failed}`);
if (failed) process.exit(1);
