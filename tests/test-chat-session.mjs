#!/usr/bin/env node

/**
 * test-chat-session.mjs — Unit tests for session-conflict detection
 * (issue #27).
 *
 * Pure regex tests against the patterns claude (and friends) emit when
 * another process is holding the same session-id. chat.mjs uses this to
 * auto-retry once with a fresh uuid instead of dead-ending the chat.
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

console.log('\nsession-conflict detection (issue #27)');

const { isSessionConflict, SESSION_CONFLICT_RE } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/public/js/lib/session-conflict.mjs')).href
);

assert(SESSION_CONFLICT_RE instanceof RegExp, 'SESSION_CONFLICT_RE is a RegExp');
assert(typeof isSessionConflict === 'function', 'isSessionConflict is a function');

console.log('\n1. Should match (real-world phrasings)');

const shouldMatch = [
  'Session is already in use',
  'session already in use',
  'Session is currently in use',
  'session is locked',
  'Session locked',
  'Session is already running',
  'session already running',
  'Session is currently active',
  'session is busy',
  'Another claude process is using this session',
  'Another claude process is holding this session',
  'Another instance is using session',
  'Another opencode instance is locking this session',
  'another process is on this session',
  'another claude run is using the session',
  'Could not acquire session',
  'Could not lock session',
  'Could not claim the session',
  'concurrent session detected',
  'ERROR: session is already in use by another process',
  'session is in use',
];

for (const msg of shouldMatch) {
  assert(isSessionConflict(msg), `matches: "${msg}"`);
}

console.log('\n2. Should NOT match (unrelated errors)');

const shouldNotMatch = [
  'Network timeout',
  'HTTP 500 internal server error',
  'Permission denied',
  'API key invalid',
  'Rate limit exceeded',
  'connect ECONNREFUSED',
  'no such file or directory',
  '',
  'request failed',
  'Token quota exhausted',
  'Compilation error in user code',
  null,
  undefined,
];

for (const msg of shouldNotMatch) {
  assert(!isSessionConflict(msg), `does not match: "${msg ?? '(nullish)'}"`);
}

console.log('\n3. Codex chat-panel continuation args');

const { agentPrintArgs } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/lib/agents.mjs')).href
);

const codexFresh = agentPrintArgs('codex', ROOT, { continueSession: false });
assert(
  JSON.stringify(codexFresh.args) === JSON.stringify(['exec']),
  'fresh Codex turn uses codex exec',
);

const codexContinued = agentPrintArgs('codex', ROOT, { continueSession: true });
assert(
  JSON.stringify(codexContinued.args) === JSON.stringify(['exec', 'resume', '--last', '-']),
  'continued Codex turn uses codex exec resume --last -',
);
assert(
  !codexContinued.args.includes('--continue'),
  'continued Codex turn does not use removed --continue flag',
);

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
