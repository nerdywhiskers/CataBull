#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
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

const streamHelpers = await import(pathToFileURL(join(ROOT, 'lib', 'scan-progress-stream.mjs')).href);
const uiHelpers = await import(pathToFileURL(join(ROOT, 'dashboard-web', 'public', 'js', 'components', 'scan-progress.mjs')).href);

const { encodeScanProgress, parseProgressLine, createLineBuffer } = streamHelpers;
const { renderScanProgress, quickProgressFromEvent, deepProgressFromEvent } = uiHelpers;

console.log('\nScan progress helpers');

const encoded = encodeScanProgress({ type: 'run:start', companies: 12 });
assert(parseProgressLine(encoded)?.companies === 12, 'parseProgressLine decodes encoded payload');
assert(parseProgressLine('plain text') === null, 'parseProgressLine ignores normal log lines');

const buffered = [];
const onChunk = createLineBuffer((line) => buffered.push(line));
onChunk(`${encoded}\nplain`);
onChunk(` tail\n${encodeScanProgress({ type: 'company:done', company: 'Acme' })}\n`);
assert(buffered.length === 3, 'createLineBuffer emits complete lines across chunk boundaries');
assert(buffered[1] === 'plain tail', 'createLineBuffer rejoins split plain-text lines');
assert(parseProgressLine(buffered[2])?.company === 'Acme', 'createLineBuffer preserves encoded progress line');

const quickStart = quickProgressFromEvent({ stage: 'quick:start' });
assert(quickStart?.visible === true, 'quick:start produces visible progress state');
assert(/ATS sweep/i.test(quickStart?.title || ''), 'quick:start title describes ATS sweep');

const quickCompany = quickProgressFromEvent({ stage: 'quick:company:start', company: 'Acme', provider: 'greenhouse', index: 2, total: 5 });
assert(/Acme/.test(quickCompany?.title || ''), 'quick company event includes company name');
assert(/2\/5/.test(quickCompany?.detail || ''), 'quick company event shows progress fraction');

const deepL3 = deepProgressFromEvent({ stage: 'l3:search:start', queryName: 'AI roles', queryIndex: 1, total: 4 });
assert(/Level 3/.test(deepL3?.eyebrow || ''), 'deep Level 3 event labels level');
assert(/AI roles/.test(deepL3?.title || ''), 'deep Level 3 event includes query name');

const html = renderScanProgress({ visible: true, tone: 'running', eyebrow: 'Quick Scan', title: 'Scanning', detail: 'Direct ATS only', meta: '2/5 complete' });
assert(/scan-progress/.test(html), 'renderScanProgress returns shared progress markup');
assert(/Quick Scan/.test(html) && /2\/5 complete/.test(html), 'rendered markup includes supplied copy');

console.log(`\nPassed ${passed}/${total}`);
if (failed > 0) process.exit(1);
