#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalWorkspace } from '../lib/workspace.mjs';
import { tailorSlug, writeTailorBundle } from '../lib/tailor.mjs';
import { parseApplications } from '../dashboard-web/lib/parsers.mjs';
import { createTailorCoordinator } from '../dashboard-web/lib/tailor-coordinator.mjs';
import Fastify from 'fastify';
import tailorRoutes from '../dashboard-web/routes/tailor.mjs';

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

const payload = {
  tailored_cv_markdown: '# CV\n\n' + 'Relevant experience and verified accomplishments. '.repeat(8),
  cover_letter_markdown: 'Dear hiring team,\n\n' + 'Specific evidence for this role. '.repeat(8),
  qa_pairs: [
    { question: 'Tell us about yourself', answer: 'Relevant background.' },
    { question: 'Why this role?', answer: 'Strong fit.' },
    { question: 'Why this company?', answer: 'Specific interest.' },
  ],
};

function makeRoot(prefix = 'catabull-tailor-idempotency-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const ws = new LocalWorkspace(root);
  ws.write('data/applications.md', '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  ws.write('data/pipeline.md', '# Pipeline\n\n## Pendientes\n');
  return { root, ws };
}

function resultFactory(ws, { delayMs = 0, onRun = () => {} } = {}) {
  return async ({ company, role }) => {
    onRun();
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const slug = tailorSlug(company, role);
    const bundle = writeTailorBundle(ws, slug, payload, { company, role });
    return { slug, ...bundle, payload };
  };
}

console.log('\ntailor idempotency coordinator');

// Concurrent canonical aliases must share one expensive generation and report.
{
  const { root, ws } = makeRoot();
  try {
    let runs = 0;
    const coordinator = createTailorCoordinator({
      root,
      runTailorFn: resultFactory(ws, { delayMs: 25, onRun: () => { runs++; } }),
      generatePdfs: async () => {},
    });
    const firstPromise = coordinator.tailor({ company: 'Acme, Inc.', role: 'Staff Designer', url: 'https://jobs.test/1' });
    const aliasPromise = coordinator.tailor({ company: 'acme', role: 'staff designer', url: 'https://jobs.test/2' });
    const [first, alias] = await Promise.all([firstPromise, aliasPromise]);

    assert(runs === 1, 'concurrent aliases invoke the agent once');
    assert(first === alias, 'concurrent aliases resolve to the same operation result');
    assert(first.report.path === alias.report.path, 'concurrent aliases bind one report');
    assert(ws.list('reports', { filter: (entry) => entry.isFile }).length === 1, 'concurrent aliases create one report file');
    assert(parseApplications(root).length === 1, 'concurrent aliases create one tracker row');

    const retry = await coordinator.tailor({ company: 'ACME INC', role: 'Staff Designer', url: 'https://jobs.test/retry' });
    assert(retry.reused === true, 'ordinary retry reuses the complete bundle');
    assert(runs === 1, 'ordinary retry does not invoke the agent again');
    assert(retry.report.path === first.report.path, 'ordinary retry keeps the original report');

    const forced = await coordinator.tailor({ company: 'Acme', role: 'Staff Designer', url: 'https://jobs.test/force', force: true });
    assert(forced.reused === false, 'forced refresh regenerates the bundle');
    assert(runs === 2, 'forced refresh invokes the agent once more');
    assert(forced.report.path === first.report.path, 'forced refresh updates the same report');
    assert(ws.list('reports', { filter: (entry) => entry.isFile }).length === 1, 'forced refresh does not allocate a duplicate report');
    const reportRaw = ws.read(first.report.path);
    assert((reportRaw.match(/catabull-tailor-bundle:start/g) || []).length === 1, 'forced refresh replaces, rather than duplicates, the report section');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// A complete bundle with a tracker row but missing report binding should be
// repaired without spending another agent call.
{
  const { root, ws } = makeRoot();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const slug = tailorSlug('Legacy Labs', 'Designer', { date: today });
    const bundle = writeTailorBundle(ws, slug, payload, { company: 'Legacy Labs', role: 'Designer' });
    ws.write('data/applications.md', '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n'
      + `| 7 | ${today} | Legacy Labs | Designer | 4.0/5 | Tailored | ❌ | | |\n`);
    let runs = 0;
    const coordinator = createTailorCoordinator({
      root,
      runTailorFn: resultFactory(ws, { onRun: () => { runs++; } }),
      generatePdfs: async () => {},
    });
    const repaired = await coordinator.tailor({ company: 'Legacy Labs, Inc.', role: 'Designer' });
    const app = parseApplications(root)[0];

    assert(runs === 0, 'complete unbound bundle is reused without an agent call');
    assert(repaired.reused === true && repaired.repaired === true, 'response identifies repaired reuse');
    assert(repaired.paths.cv === bundle.paths.cv, 'repair preserves existing canonical CV artifact');
    assert(Boolean(app.reportPath), 'repair binds a report to the existing tracker row');
    assert(ws.list('reports', { filter: (entry) => entry.isFile }).length === 1, 'repair creates only the missing report');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Failed work must leave no poisoned in-flight key; a retry can succeed.
{
  const { root, ws } = makeRoot();
  try {
    let attempts = 0;
    const coordinator = createTailorCoordinator({
      root,
      runTailorFn: async (input) => {
        attempts++;
        if (attempts === 1) throw new Error('synthetic agent failure');
        return resultFactory(ws)(input);
      },
      generatePdfs: async () => {},
    });
    try {
      await coordinator.tailor({ company: 'Retry Co', role: 'Engineer' });
    } catch {}
    const retried = await coordinator.tailor({ company: 'Retry Co', role: 'Engineer' });
    assert(attempts === 2, 'failed operation releases its canonical in-flight key');
    assert(Boolean(retried.report?.path), 'retry after failure completes normally');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Route retries should reuse completed artifacts even when no agent is
// currently configured. Agent availability matters only for new generation.
{
  const { root, ws } = makeRoot();
  const server = Fastify();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const slug = tailorSlug('Offline Co', 'Designer', { date: today });
    writeTailorBundle(ws, slug, payload, { company: 'Offline Co', role: 'Designer' });
    ws.write('data/applications.md', '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n'
      + `| 1 | ${today} | Offline Co | Designer | 4.0/5 | Tailored | ❌ | | |\n`);
    server.decorate('cataBullRoot', root);
    await server.register(tailorRoutes);
    const response = await server.inject({
      method: 'POST',
      url: '/tailor',
      payload: { company: 'Offline Co', role: 'Designer' },
    });
    const body = response.json();
    assert(response.statusCode === 200, `route reuses a complete bundle without configured agent (status=${response.statusCode}, body=${response.body})`);
    assert(body.reused === true, `route identifies no-agent retry as reuse (body=${response.body})`);
    const missingAgent = await server.inject({
      method: 'POST',
      url: '/tailor',
      payload: { company: 'New Co', role: 'Engineer' },
    });
    assert(missingAgent.statusCode === 400, 'route still requires an agent for new generation');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`Passed: ${passed} / ${passed + failed}`);
if (failed) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
