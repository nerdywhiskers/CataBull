#!/usr/bin/env node

/**
 * test-recovery.mjs — Unit tests for W8 URL recovery (PR 1.2).
 *
 * The recovery flow is mostly orchestration over already-tested
 * pieces (lib/discovery + writers.updateCompany). These tests pin
 * down the contract: the route returns the right shape, and
 * acceptance correctly mutates portals.yml.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

const { LocalWorkspace } = await import('../lib/workspace.mjs');
const { discoverCompany } = await import('../lib/discovery.mjs');
const { updateCompany, readPortals } = await import('../dashboard-web/lib/writers.mjs');

console.log('\nW8 URL recovery (PR 1.2)');

function withTempPortals(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'careerbot-recover-test-'));
  const ws = new LocalWorkspace(dir);
  // Seed a portals.yml with one auto-disabled company.
  ws.writeYaml('portals.yml', {
    title_filter: { positive: ['Engineer'], negative: [] },
    tracked_companies: [
      {
        name: 'Vinted',
        careers_url: 'https://jobs.lever.co/vinted',
        enabled: false,
        auto_disabled: true,
        health: {
          last_check: '2026-04-30',
          last_status: 'not_found',
          last_error: 'lever: HTTP 404',
          consecutive_failures: 5,
        },
      },
      {
        name: 'Healthy Co',
        careers_url: 'https://job-boards.greenhouse.io/healthyco',
        enabled: true,
      },
    ],
  });
  return Promise.resolve()
    .then(() => fn(ws, dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
}

// ── 1. Discovery for a known auto-disabled name ───────────────────────

console.log('\n1. discoverCompany scoped to one name (recovery use case)');

await withTempPortals(async (ws) => {
  const stubVerify = async (name) => ({
    careers_url: 'https://jobs.lever.co/vinted-marketplace',
    provider: 'lever',
    confidence: 'high',
    notes: 'Found Vinted Marketplace ATS',
  });
  const stubHealth = async () => ({
    name: 'Vinted',
    status: 'healthy',
    provider: 'lever',
    sampleJobs: [
      { title: 'Senior Backend Engineer' },
      { title: 'Designer' },
      { title: 'Staff Engineer' },
    ],
  });

  const result = await discoverCompany(
    { name: 'Vinted', industries: ['ecommerce'] },
    {
      verify: stubVerify,
      checkCompany: stubHealth,
      titleFilter: { positive: ['Engineer'], negative: [] },
    }
  );

  assert(result.status === 'enabled', 'recovery returns enabled when URL works and role fits');
  assert(result.careers_url === 'https://jobs.lever.co/vinted-marketplace', 'proposed URL exposed');
  assert(result.role_fit === 'matches', 'role-fit captured');
  assert(result.role_fit_meta.matchCount === 2, 'match count surfaces (2 of 3 sample)');
});

await withTempPortals(async (ws) => {
  // Recovery where the agent can't find a working URL
  const noUrlVerify = async () => null;
  const stubHealth = async () => ({ status: 'not_found' });

  const result = await discoverCompany(
    { name: 'Mystery' },
    { verify: noUrlVerify, checkCompany: stubHealth }
  );

  assert(result.status === 'disabled_no_url', 'no URL found → disabled_no_url');
  assert(result.careers_url == null, 'no careers_url leaked');
});

// ── 2. updateCompany applies recovery cleanly ────────────────────────

console.log('\n2. updateCompany — accept-recovery path');

await withTempPortals((ws) => {
  // Apply the proposed URL like /health/recover/:name/accept does.
  const ok = updateCompany(ws.root, 'Vinted', {
    careers_url: 'https://jobs.lever.co/vinted-marketplace',
    enabled: true,
    auto_disabled: false,
    health: {
      consecutive_failures: 0,
      last_error: undefined,
    },
  });
  assert(ok === true, 'updateCompany returns true on success');

  const portals = readPortals(ws.root);
  const vinted = portals.tracked_companies.find((c) => c.name === 'Vinted');
  assert(vinted.careers_url === 'https://jobs.lever.co/vinted-marketplace', 'careers_url updated');
  assert(vinted.enabled === true, 'enabled flipped on');
  assert(!vinted.auto_disabled, 'auto_disabled cleared');
  assert(vinted.health.consecutive_failures === 0, 'failure counter reset');
});

await withTempPortals((ws) => {
  // Updating a non-existent company → false, no mutation
  const ok = updateCompany(ws.root, 'NotARealCompany', { enabled: true });
  assert(ok === false, 'updateCompany returns false for unknown name');
  const portals = readPortals(ws.root);
  assert(portals.tracked_companies.length === 2, 'no spurious entries created');
});

// ── 3. Recovery preserves unrelated companies ────────────────────────

console.log('\n3. Recovery isolation (other rows untouched)');

await withTempPortals((ws) => {
  updateCompany(ws.root, 'Vinted', {
    careers_url: 'https://jobs.lever.co/vinted-marketplace',
    enabled: true,
    auto_disabled: false,
  });
  const portals = readPortals(ws.root);
  const healthy = portals.tracked_companies.find((c) => c.name === 'Healthy Co');
  assert(healthy.careers_url === 'https://job-boards.greenhouse.io/healthyco', 'unrelated URL untouched');
  assert(healthy.enabled === true, 'unrelated enabled flag untouched');
});

// ── 4. Recovery contract: requires_acceptance flag ───────────────────

console.log('\n4. Recovery contract — requires_acceptance heuristic');

// Simulating the route logic: requires_acceptance = proposed_url exists AND differs
function requiresAcceptance(oldUrl, proposedUrl) {
  return Boolean(proposedUrl) && proposedUrl !== oldUrl;
}
assert(requiresAcceptance('https://a', 'https://b') === true, 'different URLs → needs acceptance');
assert(requiresAcceptance('https://a', 'https://a') === false, 'same URL → no acceptance needed');
assert(requiresAcceptance('https://a', null) === false, 'no proposal → no acceptance');
assert(requiresAcceptance(null, 'https://b') === true, 'no old URL but found new → needs acceptance');

// ── DONE ──────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
