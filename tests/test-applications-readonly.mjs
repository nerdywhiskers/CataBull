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
  const discoverPath = join(root, 'data', 'discover.md');
  writeFileSync(discoverPath, '# Discover\n\n- [ ] https://jobs.test/new-role | NewCo | Product Designer | posted:2026-08-06 | loc:Remote | match:high | llm:4.0 | why:Exact profile fit | signals:portfolio,leadership\n- [ ] https://jobs.test/new-role-mirror | NewCo, Inc. | Product Designer\n- [ ] https://jobs.test/acme-mirror | Acme, Inc. | Designer\n');

  server.decorate('cataBullRoot', root);
  await server.register(applicationsRoute);
  const response = await server.inject({ method: 'GET', url: '/applications' });
  const body = response.json();

  assert(response.statusCode === 200, 'GET /applications succeeds');
  assert(body.pendingTotal === 0, 'GET filters already-tracked roles from response');
  assert(body.discoverTotal === 1, 'GET returns only untracked, canonically deduplicated discoveries');
  assert(body.discover[0].url === 'https://jobs.test/new-role', 'GET preserves first discovery and its stable URL');
  assert(readFileSync(pipelinePath, 'utf8') === originalPipeline, 'GET does not rewrite pipeline state');
  assert(readFileSync(discoverPath, 'utf8').includes('new-role-mirror'), 'GET does not destructively rewrite duplicate discovery rows');

  const promoteResponse = await server.inject({
    method: 'POST',
    url: '/discover/add-to-pipeline',
    payload: { url: 'https://jobs.test/new-role' },
  });
  assert(promoteResponse.statusCode === 200, 'POST /discover/add-to-pipeline succeeds');
  assert(promoteResponse.json().success === true, 'promotion reports success');
  const promotedPipeline = readFileSync(pipelinePath, 'utf8');
  const promotedDiscover = readFileSync(discoverPath, 'utf8');
  assert(promotedPipeline.includes('https://jobs.test/new-role | NewCo | Product Designer | posted:2026-08-06 | loc:Remote'), 'promotion preserves discovery metadata in pipeline');
  assert(promotedPipeline.includes('| match:high | llm:4.0 | why:Exact profile fit | signals:portfolio,leadership'), 'promotion preserves match and contextual score metadata');
  assert(!promotedDiscover.includes('NewCo | Product Designer'), 'promotion removes the selected role from Discover');
  assert(!promotedDiscover.includes('NewCo, Inc. | Product Designer'), 'promotion removes canonical duplicate mirrors from Discover');

  const repeatPromotion = await server.inject({
    method: 'POST',
    url: '/discover/add-to-pipeline',
    payload: { url: 'https://jobs.test/new-role' },
  });
  assert(repeatPromotion.statusCode === 200, 'repeated promotion is idempotent');
  assert((readFileSync(pipelinePath, 'utf8').match(/Product Designer/g) || []).length === 1, 'repeated promotion never duplicates the pipeline row');

  const substringPromotion = await server.inject({
    method: 'POST',
    url: '/discover/add-to-pipeline',
    payload: { url: 'https://jobs.test/new' },
  });
  assert(substringPromotion.statusCode === 404, 'idempotency requires an exact pipeline URL instead of a substring match');

  writeFileSync(discoverPath, '# Discover\n\n- [ ] https://jobs.test/new | SmallCo | Small Role\n');
  const distinctShortUrlPromotion = await server.inject({
    method: 'POST',
    url: '/discover/add-to-pipeline',
    payload: { url: 'https://jobs.test/new' },
  });
  assert(distinctShortUrlPromotion.statusCode === 200, 'a shorter distinct URL can still be promoted');
  assert(readFileSync(pipelinePath, 'utf8').includes('https://jobs.test/new | SmallCo | Small Role'), 'URL dedupe uses exact identity instead of substring containment');

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

  writeFileSync(pipelinePath, '# Pipeline\n\n- [ ] https://jobs.test/old-url | EditCo | Edit Role | posted:2026-08-01 | loc:Remote\n');
  const renameResponse = await server.inject({
    method: 'PATCH',
    url: '/pipeline/item',
    payload: {
      url: 'https://jobs.test/old-url',
      company: 'EditCo',
      role: 'Edit Role',
      postedAt: '2026-08-01',
      location: 'Remote',
      newUrl: 'https://jobs.test/new-url',
    },
  });
  assert(renameResponse.statusCode === 200, 'PATCH /pipeline/item with newUrl completes');
  assert(renameResponse.json().success === true, 'PATCH /pipeline/item reports the url rename succeeded');
  const renamedFile = readFileSync(pipelinePath, 'utf8');
  assert(renamedFile.includes('https://jobs.test/new-url | EditCo | Edit Role | posted:2026-08-01 | loc:Remote'), 'url rename persists the new url with metadata intact');
  assert(!renamedFile.includes('https://jobs.test/old-url'), 'url rename removes the old url from the pipeline');

  const badSchemeResponse = await server.inject({
    method: 'PATCH',
    url: '/pipeline/item',
    payload: {
      url: 'https://jobs.test/new-url',
      company: 'EditCo',
      role: 'Edit Role',
      newUrl: 'ftp://jobs.test/bad-scheme',
    },
  });
  assert(badSchemeResponse.statusCode === 400, 'PATCH /pipeline/item rejects a newUrl without an http(s) scheme');
  assert(!readFileSync(pipelinePath, 'utf8').includes('ftp://jobs.test/bad-scheme'), 'rejected url rename does not touch the pipeline');

  const badCharResponse = await server.inject({
    method: 'PATCH',
    url: '/pipeline/item',
    payload: {
      url: 'https://jobs.test/new-url',
      company: 'EditCo',
      role: 'Edit Role',
      newUrl: 'https://jobs.test/pipe|char',
    },
  });
  assert(badCharResponse.statusCode === 400, 'PATCH /pipeline/item rejects a newUrl containing a pipe character');
} finally {
  await server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`Passed: ${passed} / ${passed + failed}`);
if (failed) process.exit(1);
