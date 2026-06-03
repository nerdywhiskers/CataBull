#!/usr/bin/env node

/**
 * test-core.mjs — Unit tests for core library modules
 *
 * Run standalone or from test-all.mjs.
 * Tests: parsers (normalizeStatus, parseApplications), liveness-core,
 *        spawn-timeout (basic spawn), writers (applicationsPath).
 *
 * Usage:
 *   node test-core.mjs
 *   node test-core.mjs --verbose
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';

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

function assertThrows(fn, msg) {
  total++;
  try {
    fn();
    failed++;
    console.log(`  ❌ ${msg} (expected throw, got none)`);
  } catch {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  }
}

// ── 1. NORMALIZE STATUS ──────────────────────────────────────────

console.log('\n1. normalizeStatus');

const { normalizeStatus } = await import(pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'parsers.mjs')).href);

assert(normalizeStatus('Applied') === 'applied', 'Applied → applied');
assert(normalizeStatus('aplicado') === 'applied', 'aplicado → applied');
assert(normalizeStatus('Sent') === 'applied', 'Sent → applied');
assert(normalizeStatus('Interview') === 'interview', 'Interview → interview');
assert(normalizeStatus('Entrevista') === 'interview', 'Entrevista → interview');
assert(normalizeStatus('Offer') === 'offer', 'Offer → offer');
assert(normalizeStatus('Oferta') === 'offer', 'Oferta → offer');
assert(normalizeStatus('Rejected') === 'rejected', 'Rejected → rejected');
assert(normalizeStatus('Rechazado') === 'rejected', 'Rechazado → rejected');
assert(normalizeStatus('Skip') === 'skip', 'Skip → skip');
assert(normalizeStatus('No aplicar') === 'skip', 'No aplicar → skip');
assert(normalizeStatus('Geo blocker') === 'skip', 'Geo blocker → skip');
assert(normalizeStatus('Discarded') === 'discarded', 'Discarded → discarded');
assert(normalizeStatus('Descartado') === 'discarded', 'Descartado → discarded');
assert(normalizeStatus('Duplicado') === 'discarded', 'Duplicado → discarded');
assert(normalizeStatus('Dup') === 'discarded', 'Dup → discarded');
assert(normalizeStatus('Evaluated') === 'evaluated', 'Evaluated → evaluated');
assert(normalizeStatus('Hold') === 'evaluated', 'Hold → evaluated');
assert(normalizeStatus('Monitor') === 'evaluated', 'Monitor → evaluated');
assert(normalizeStatus('Responded') === 'responded', 'Responded → responded');
assert(normalizeStatus('Respondido') === 'responded', 'Respondido → responded');
assert(normalizeStatus('Cerrada') === 'discarded', 'Cerrada → discarded');
assert(normalizeStatus('Cancelada') === 'discarded', 'Cancelada → discarded');
assert(normalizeStatus('Enviada') === 'applied', 'Enviada → applied (non-accented)');
assert(normalizeStatus('Aplicada') === 'applied', 'Aplicada → applied');
assert(normalizeStatus('Condicional') === 'evaluated', 'Condicional → evaluated');
assert(normalizeStatus('Evaluar') === 'evaluated', 'Evaluar → evaluated');
assert(normalizeStatus('Verificar') === 'evaluated', 'Verificar → evaluated');

// Strip trailing dates
assert(normalizeStatus('Applied  2026-04-01') === 'applied', 'Strips trailing date: "Applied  2026-04-01" → applied');
assert(normalizeStatus('Rejected  2026-03-15') === 'rejected', 'Strips trailing date: "Rejected  2026-03-15" → rejected');

// ── 2. STATUS PRIORITY ──────────────────────────────────────────

console.log('\n2. statusPriority');

const { statusPriority } = await import(pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'parsers.mjs')).href);

assert(statusPriority('interview') === 0, 'interview has highest priority (0)');
assert(statusPriority('offer') === 1, 'offer has priority (1)');
assert(statusPriority('responded') === 2, 'responded has priority (2)');
assert(statusPriority('applied') === 3, 'applied has priority (3)');
assert(statusPriority('evaluated') === 4, 'evaluated has priority (4)');
assert(statusPriority('skip') === 5, 'skip has priority (5)');
assert(statusPriority('rejected') === 6, 'rejected has priority (6)');
assert(statusPriority('discarded') === 7, 'discarded has lowest priority (7)');
assert(statusPriority('unknown') === 8, 'unknown status gets default priority (8)');

// ── 3. LIVE CLASSIFICATION ──────────────────────────────────────

console.log('\n3. classifyLiveness');

const { classifyLiveness } = await import(pathToFileURL(join(ROOT, 'lib/liveness-core.mjs')).href);

// HTTP status codes
assert(classifyLiveness({ status: 404 }).result === 'expired', '404 → expired');
assert(classifyLiveness({ status: 410 }).result === 'expired', '410 → expired');
assert(classifyLiveness({ status: 403 }).result === 'uncertain', '403 bot block -> uncertain');
assert(classifyLiveness({ status: 429 }).result === 'uncertain', '429 rate limit -> uncertain');
assert(classifyLiveness({ status: 503 }).result === 'uncertain', '5xx transient error -> uncertain');

// URL patterns
assert(classifyLiveness({ finalUrl: 'https://example.com?error=true' }).result === 'expired', 'URL with ?error=true → expired');

// Body patterns — expired only for clear gone/closed signals
assert(classifyLiveness({ bodyText: 'No longer accepting applications' }).result === 'expired', 'no longer accepting → expired');
assert(classifyLiveness({ bodyText: 'The page you are looking for does not exist' }).result === 'expired', 'page not found → expired');
assert(classifyLiveness({ bodyText: 'Job listing not found' }).result === 'expired', 'job listing not found → expired');

// Body patterns — uncertain when not clearly gone/closed
assert(classifyLiveness({ bodyText: 'The job is no longer available' }).result === 'uncertain', 'no longer available stays uncertain');
assert(classifyLiveness({ bodyText: 'This position has been filled' }).result === 'uncertain', 'position filled stays uncertain');
assert(classifyLiveness({ bodyText: 'This job posting has expired' }).result === 'uncertain', 'posting expired stays uncertain');
assert(classifyLiveness({ bodyText: 'Diese Stelle ist nicht mehr besetzt' }).result === 'uncertain', 'German closed phrasing stays uncertain');
assert(classifyLiveness({ bodyText: 'Cette offre expirée' }).result === 'uncertain', 'French closed phrasing stays uncertain');

// Listing/search shells are uncertain unless clearly gone/closed
assert(classifyLiveness({ bodyText: '663 JOBS FOUND' }).result === 'uncertain', 'listing page → uncertain');
assert(classifyLiveness({ bodyText: 'Search for jobs page is loaded' }).result === 'uncertain', 'search page → uncertain');

// Body patterns — active (apply control)
assert(classifyLiveness({ applyControls: ['Apply for this Job'] }).result === 'active', 'apply control → active');
assert(classifyLiveness({ applyControls: ['Easy Apply', 'Submit Application'] }).result === 'active', 'easy apply → active');

// Body patterns — uncertain (content but no apply control)
const uncertain = classifyLiveness({ bodyText: 'This is a long company description with enough content to pass the minimum character threshold of 300 characters but has no visible apply button or control found on the page at all for the user to interact with in any meaningful way to apply for the position or learn more about the role and understand the company culture and values' });
assert(uncertain.result === 'uncertain', 'long content no apply → uncertain');

// Body patterns — uncertain (too little content to verify)
assert(classifyLiveness({ bodyText: 'Nav' }).result === 'uncertain', 'short content → uncertain');

console.log('\n3b. buildTitleFilter');

const { buildTitleFilter, buildTitleClassifier } = await import(pathToFileURL(join(ROOT, 'lib', 'title-filter.mjs')).href);
const creativeFilter = buildTitleFilter({
  positive: ['Art Director', 'Lead Designer'],
  negative: ['Intern'],
});
const creativeClassify = buildTitleClassifier({
  positive: ['Art Director', 'Lead Designer'],
  negative: ['Intern'],
});
assert(creativeFilter('Senior Art/Creative Director') === true, 'flex title match catches separator/inserted word');
assert(creativeFilter('Director of Art') === true, 'flex title match catches reordered words');
assert(creativeFilter('Lead Visual Designer') === true, 'flex title match catches inserted descriptor');
assert(creativeClassify('Product Designer').decision === 'review', 'single inferred role token becomes review');
assert(creativeClassify('Sales Director').decision === 'skip', 'generic seniority token alone is skipped');
assert(creativeClassify('Technical Support Engineer').decision === 'skip', 'technical support is not review noise');
assert(creativeClassify('Technical Product Manager').decision === 'skip', 'technical product manager is not review noise');
assert(creativeClassify('Tattoo Artist').decision === 'skip', 'tattoo artist is not review noise');
const artistClassify = buildTitleClassifier({
  positive: ['Concept Artist'],
  negative: ['Intern'],
});
assert(artistClassify('Character Artist').decision === 'review', 'artist role family still reaches review');
assert(creativeFilter('Art Director Intern') === false, 'negative keyword still blocks flexible positive');

// ── 4. APPLICATIONS PATH RESOLUTION ─────────────────────────────

console.log('\n4. applicationsPath');

const { applicationsPath } = await import(pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'writers.mjs')).href);

// Test with data/ version present
const testRoot1 = join(ROOT, '.tmp-test-apps-path-1');
mkdirSync(testRoot1, { recursive: true });
mkdirSync(join(testRoot1, 'data'), { recursive: true });
writeFileSync(join(testRoot1, 'data', 'applications.md'), '# Applications');
assert(applicationsPath(testRoot1) === join(testRoot1, 'data', 'applications.md'), 'data/applications.md takes precedence');

// Test with root version only
const testRoot2 = join(ROOT, '.tmp-test-apps-path-2');
mkdirSync(testRoot2, { recursive: true });
writeFileSync(join(testRoot2, 'applications.md'), '# Applications');
assert(applicationsPath(testRoot2) === join(testRoot2, 'applications.md'), 'root applications.md fallback');

// Test with neither
const testRoot3 = join(ROOT, '.tmp-test-apps-path-3');
mkdirSync(testRoot3, { recursive: true });
assert(applicationsPath(testRoot3) === join(testRoot3, 'applications.md'), 'returns root path even if file missing');

// Cleanup
rmSync(testRoot1, { recursive: true, force: true });
rmSync(testRoot2, { recursive: true, force: true });
rmSync(testRoot3, { recursive: true, force: true });

// ── 5. SPAWN WITH TIMEOUT ───────────────────────────────────────

console.log('\n5. spawnWithTimeout');

const { spawnWithTimeout } = await import(pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'spawn-timeout.mjs')).href);

// Create a temporary test script
const testScriptPath = join(ROOT, '.tmp-test-script.mjs');
writeFileSync(testScriptPath, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ status: "ok", value: 42 }));\n');

// Test a quick successful spawn
const result = await spawnWithTimeout(testScriptPath, [], { cwd: ROOT, timeoutMs: 10000 });
assert(result.exitCode === 0, `spawn test script exits 0 (got ${result.exitCode})`);
assert(result.stdout.includes('"status":"ok"'), 'spawn output contains expected JSON');

// Cleanup
rmSync(testScriptPath, { force: true });

// ── SUMMARY ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`📊 Results: ${passed}/${total} passed, ${failed} failed`);

if (failed > 0) {
  console.log('🔴 TESTS FAILED\n');
  process.exit(1);
} else {
  console.log('🟢 All core tests passed\n');
  process.exit(0);
}
