#!/usr/bin/env node

/**
 * test-health.mjs — Unit tests for scan/health.mjs
 *
 * Pure-logic tests against the classifier and orchestration. Does not
 * make real HTTP calls — providers are stubbed in process.
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

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

console.log('\nscan/health.mjs');

const {
  HEALTH_STATUSES,
  suggestedAction,
  checkCompanies,
  checkCompany,
  applyHealthResult,
  shouldAutoDisable,
  AUTO_DISABLE_THRESHOLD,
  isHealthyStatus,
} = await import(
  pathToFileURL(join(ROOT, 'scan', 'health.mjs')).href
);

// ── 1. STATUS TAXONOMY ──────────────────────────────────────────────

console.log('\n1. Status taxonomy');
assert(HEALTH_STATUSES.includes('healthy'), 'taxonomy includes healthy');
assert(HEALTH_STATUSES.includes('not_found'), 'taxonomy includes not_found');
assert(HEALTH_STATUSES.includes('bot_blocked'), 'taxonomy includes bot_blocked');
assert(HEALTH_STATUSES.includes('unknown_ats'), 'taxonomy includes unknown_ats');
assert(HEALTH_STATUSES.includes('no_provider'), 'taxonomy includes no_provider');
assert(HEALTH_STATUSES.length === 8, 'taxonomy has exactly 8 statuses');

// ── 2. SUGGESTED ACTIONS ────────────────────────────────────────────

console.log('\n2. Suggested actions');
for (const status of HEALTH_STATUSES) {
  const action = suggestedAction(status);
  assert(typeof action === 'string' && action.length > 0, `${status} → non-empty action`);
}
assert(suggestedAction('not_found').toLowerCase().includes('new'), 'not_found suggests finding new URL');
assert(suggestedAction('bot_blocked').toLowerCase().includes('stealth') || suggestedAction('bot_blocked').toLowerCase().includes('block'), 'bot_blocked mentions blocking');

// ── 3. NO PROVIDER PATH ─────────────────────────────────────────────

console.log('\n3. checkCompany — no provider');
const result = await checkCompany({ name: 'Test', enabled: true });  // no careers_url, no api
assert(result.status === 'no_provider', 'company without urls → no_provider');
assert(result.name === 'Test', 'name preserved');
assert(typeof result.checkedAt === 'string' && /^\d{4}-/.test(result.checkedAt), 'checkedAt is ISO timestamp');

// ── 4. ORCHESTRATION (parallel) ─────────────────────────────────────

console.log('\n4. checkCompanies orchestration');
const companies = [
  { name: 'A', enabled: true },        // no provider
  { name: 'B', enabled: false },       // no provider
  { name: 'C', enabled: true },        // no provider
];
const snapshot = await checkCompanies(companies, { concurrency: 2 });
assert(Array.isArray(snapshot.companies), 'snapshot has companies array');
assert(snapshot.companies.length === 3, 'all companies returned');
assert(snapshot.summary.no_provider === 3, 'summary tallies no_provider');
assert(snapshot.summary.healthy === 0, 'no false-positive healthy entries');
assert(typeof snapshot.startedAt === 'string', 'snapshot has startedAt');
assert(typeof snapshot.finishedAt === 'string', 'snapshot has finishedAt');
assert(new Date(snapshot.finishedAt) >= new Date(snapshot.startedAt), 'finishedAt >= startedAt');

// ── 5. PROGRESS CALLBACK ────────────────────────────────────────────

console.log('\n5. Progress callback');
const progress = [];
await checkCompanies(
  [{ name: 'X' }, { name: 'Y' }],
  { concurrency: 1, onProgress: (p) => progress.push(p) },
);
assert(progress.length === 2, 'onProgress fires once per company');
assert(progress[0].done === 1 && progress[0].total === 2, 'first progress event: done=1');
assert(progress[1].done === 2, 'second progress event: done=2');

// ── 6. SUMMARY KEY COMPLETENESS ─────────────────────────────────────

console.log('\n6. Summary key completeness');
const empty = await checkCompanies([], { concurrency: 1 });
assert(empty.companies.length === 0, 'empty input → empty companies array');
for (const status of HEALTH_STATUSES) {
  assert(empty.summary[status] === 0, `empty input → summary.${status} === 0`);
}

// ── 7. W4 — applyHealthResult ───────────────────────────────────────

console.log('\n7. applyHealthResult (W4)');

assert(isHealthyStatus('healthy') === true, 'isHealthyStatus("healthy")');
assert(isHealthyStatus('empty') === true, 'isHealthyStatus("empty")');
assert(isHealthyStatus('not_found') === false, 'isHealthyStatus("not_found")');
assert(isHealthyStatus('bot_blocked') === false, 'isHealthyStatus("bot_blocked")');

const fresh = applyHealthResult(undefined, { status: 'healthy' });
assert(fresh.consecutive_failures === 0, 'fresh + healthy → counter 0');
assert(typeof fresh.last_ok === 'string' && fresh.last_ok.length === 10, 'last_ok set to YYYY-MM-DD');
assert(typeof fresh.last_check === 'string', 'last_check set');
assert(fresh.last_status === 'healthy', 'last_status preserved');

const oneFail = applyHealthResult(undefined, { status: 'not_found', error: 'HTTP 404' });
assert(oneFail.consecutive_failures === 1, 'fresh + failure → counter 1');
assert(oneFail.last_error === 'HTTP 404', 'last_error captured');
assert(oneFail.last_ok === undefined, 'no last_ok on first failure');

const repeated = applyHealthResult(oneFail, { status: 'not_found', error: 'still 404' });
assert(repeated.consecutive_failures === 2, 'two failures → counter 2');
assert(repeated.last_error === 'still 404', 'last_error updates on each failure');

const recovered = applyHealthResult(repeated, { status: 'healthy' });
assert(recovered.consecutive_failures === 0, 'success after failures → counter resets to 0');
assert(recovered.last_error === undefined, 'success clears last_error');
assert(typeof recovered.last_ok === 'string', 'success sets last_ok');

const empty404 = applyHealthResult({ consecutive_failures: 5, last_error: 'X' }, { status: 'empty' });
assert(empty404.consecutive_failures === 0, 'empty status counts as healthy and resets counter');

// ── 8. W4 — shouldAutoDisable ──────────────────────────────────────

console.log('\n8. shouldAutoDisable (W4)');
assert(shouldAutoDisable({ consecutive_failures: 0 }).disable === false, '0 failures → no disable');
assert(shouldAutoDisable({ consecutive_failures: 2 }).disable === false, '2 failures → no disable (under threshold)');
assert(shouldAutoDisable({ consecutive_failures: AUTO_DISABLE_THRESHOLD }).disable === true, 'at threshold → disable');
assert(shouldAutoDisable({ consecutive_failures: AUTO_DISABLE_THRESHOLD + 5 }).disable === true, 'past threshold → disable');
assert(shouldAutoDisable({}).disable === false, 'no counter → no disable');
assert(shouldAutoDisable(null).disable === false, 'null block → no disable');
assert(shouldAutoDisable({ consecutive_failures: AUTO_DISABLE_THRESHOLD }).threshold === AUTO_DISABLE_THRESHOLD, 'threshold returned for UI');

// ── 9. W5 — sniffer integration ─────────────────────────────────────

console.log('\n9. Sniffer integration (W5)');

// applyHealthResult preserves sniff metadata when classifier surfaces it.
const sniffResult = {
  status: 'unknown_ats',
  error: 'Page loaded but no recognizable job links found',
  sniffedCandidates: [
    { provider: 'workday', slug: 'adobe/external_experienced', url: 'https://adobe.wd5.myworkdayjobs.com/external_experienced', score: 13 },
  ],
  suggestedCareersUrl: 'https://adobe.wd5.myworkdayjobs.com/external_experienced',
  suggestedProvider: 'workday',
};
const sniffApplied = applyHealthResult(undefined, sniffResult);
assert(Array.isArray(sniffApplied.sniffed_candidates), 'sniffed_candidates persisted on health record');
assert(sniffApplied.sniffed_candidates.length === 1, 'one candidate stored');
assert(sniffApplied.suggested_careers_url === 'https://adobe.wd5.myworkdayjobs.com/external_experienced', 'suggested URL stored');
assert(sniffApplied.suggested_provider === 'workday', 'suggested provider stored');
assert(sniffApplied.consecutive_failures === 1, 'unknown_ats still increments failure counter');

// Healthy status clears stale sniff metadata.
const healthyAfterSniff = applyHealthResult(sniffApplied, { status: 'healthy' });
assert(!('sniffed_candidates' in healthyAfterSniff), 'healthy result clears sniffed_candidates');
assert(!('suggested_careers_url' in healthyAfterSniff), 'healthy result clears suggested_careers_url');
assert(!('suggested_provider' in healthyAfterSniff), 'healthy result clears suggested_provider');

// shouldAutoDisable defers when a suggestion is pending review.
const overThresholdWithSuggestion = {
  consecutive_failures: AUTO_DISABLE_THRESHOLD + 2,
  sniffed_candidates: [{ provider: 'workday', slug: 'foo', url: 'https://x.com/y' }],
};
const verdict = shouldAutoDisable(overThresholdWithSuggestion);
assert(verdict.disable === false, 'sniff candidates pending → auto-disable deferred');
assert(verdict.skippedDueToSuggestion === true, 'skip flag set so dashboard can explain why');

const overThresholdNoSuggestion = { consecutive_failures: AUTO_DISABLE_THRESHOLD };
assert(shouldAutoDisable(overThresholdNoSuggestion).disable === true, 'no suggestion → auto-disable still fires');

// applyHealthResult: subsequent failure WITHOUT new candidates preserves
// the prior suggestion (so the user doesn't lose it across re-checks
// where the page momentarily times out).
const failAgainNoCandidates = applyHealthResult(sniffApplied, { status: 'unknown_ats', error: 'transient' });
assert(failAgainNoCandidates.suggested_careers_url === sniffApplied.suggested_careers_url, 'prior suggestion preserved on re-fail');

// ── DONE ────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
