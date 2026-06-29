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
  JSON.stringify(codexFresh.args) === JSON.stringify([
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy="on-request"',
  ]),
  'fresh Codex turn forces workspace-write + on-request',
);

const codexContinued = agentPrintArgs('codex', ROOT, { continueSession: true });
assert(
  JSON.stringify(codexContinued.args) === JSON.stringify([
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    '-c', 'approval_policy="on-request"',
    'resume', '--last', '-',
  ]),
  'continued Codex turn keeps workspace-write + on-request and resumes last',
);
assert(
  !codexContinued.args.includes('--continue'),
  'continued Codex turn does not use removed --continue flag',
);
assert(
  !codexContinued.args.includes('--ask-for-approval'),
  'Codex exec args do not use removed --ask-for-approval flag',
);

const { agentPtyConfig } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/lib/agents.mjs')).href
);

const codexPty = agentPtyConfig('codex', ROOT);
assert(
  JSON.stringify(codexPty?.args || []) === JSON.stringify([
    '--sandbox', 'workspace-write',
    '--ask-for-approval', 'on-request',
  ]),
  'Codex PTY session also forces workspace-write + on-request',
);

console.log('\n4. Opencode chat-panel args');

const opencodeFresh = agentPrintArgs('opencode', ROOT, { continueSession: false });
assert(
  JSON.stringify(opencodeFresh.args) === JSON.stringify([
    'run',
    '--format', 'json',
    '--dir', ROOT,
    '',
  ]),
  'fresh Opencode turn uses JSON format and positional prompt',
);
assert(opencodeFresh.promptVia === 'argv', 'fresh Opencode prompt is passed via argv');

const opencodeContinued = agentPrintArgs('opencode', ROOT, { continueSession: true });
assert(
  JSON.stringify(opencodeContinued.args) === JSON.stringify([
    'run',
    '--format', 'json',
    '--dir', ROOT,
    '--continue',
    '',
  ]),
  'continued Opencode turn resumes and still passes prompt via argv',
);

const opencodePty = agentPtyConfig('opencode', ROOT);
assert(
  JSON.stringify(opencodePty?.args || []) === JSON.stringify([]),
  'Opencode PTY session omits unsupported --pure flag',
);

const { agentStartFailureMessage } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/lib/agents.mjs')).href
);

const opencodeSpawnError = agentStartFailureMessage(
  'opencode',
  '/usr/local/bin/opencode',
  new Error('posix_spawnp failed'),
);
assert(
  opencodeSpawnError.includes('CataBull tried to clear macOS quarantine automatically first'),
  'Opencode spawn errors mention automatic quarantine repair',
);
assert(
  opencodeSpawnError.includes('wrong architecture'),
  'Opencode spawn errors mention wrong-architecture installs',
);
assert(
  opencodeSpawnError.includes('which opencode'),
  'Opencode spawn errors mention shell alias/path checks',
);

const plainStartError = agentStartFailureMessage('opencode', '/usr/local/bin/opencode', new Error('network down'));
assert(
  !plainStartError.includes('wrong architecture'),
  'non-spawn errors do not include Mac binary repair hint',
);

console.log('\n5. Claude chat-panel session args');

const claudeFresh = agentPrintArgs('claude', ROOT, {
  sessionId: '123e4567-e89b-12d3-a456-426614174000',
  continueSession: false,
});
assert(
  JSON.stringify(claudeFresh.args) === JSON.stringify([
    '-p',
    '--output-format', 'text',
    '--session-id', '123e4567-e89b-12d3-a456-426614174000',
  ]),
  'fresh Claude turn uses --session-id to create the named session',
);

const claudeContinued = agentPrintArgs('claude', ROOT, {
  sessionId: '123e4567-e89b-12d3-a456-426614174000',
  continueSession: true,
});
assert(
  JSON.stringify(claudeContinued.args) === JSON.stringify([
    '-p',
    '--output-format', 'text',
    '--resume', '123e4567-e89b-12d3-a456-426614174000',
  ]),
  'continued Claude turn uses --resume instead of reusing --session-id',
);

console.log('\n6. Hermes chat-panel continuation args');

const hermesFresh = agentPrintArgs('hermes', ROOT, {
  prompt: 'hello',
  continueSession: false,
});
assert(
  JSON.stringify(hermesFresh.args) === JSON.stringify(['chat', '-q', 'hello', '-Q', '--yolo']),
  'fresh Hermes turn does not resume prior context',
);

const hermesContinued = agentPrintArgs('hermes', ROOT, {
  prompt: 'follow up',
  continueSession: true,
});
assert(
  JSON.stringify(hermesContinued.args) === JSON.stringify(['chat', '--continue', '-q', 'follow up', '-Q', '--yolo']),
  'continued Hermes turn uses --continue',
);

console.log('\n7. OpenClaw chat-panel session args');

const openclawFresh = agentPrintArgs('openclaw', ROOT, {
  prompt: 'status',
  sessionId: null,
});
assert(
  JSON.stringify(openclawFresh.args) === JSON.stringify(['agent', '--agent', 'main', '--message', 'status', '--json']),
  'fresh OpenClaw turn without sticky id omits --session-id',
);

const openclawSticky = agentPrintArgs('openclaw', ROOT, {
  prompt: 'status',
  sessionId: '123e4567-e89b-12d3-a456-426614174000',
});
assert(
  JSON.stringify(openclawSticky.args) === JSON.stringify([
    'agent',
    '--agent', 'main',
    '--session-id', '123e4567-e89b-12d3-a456-426614174000',
    '--message', 'status',
    '--json',
  ]),
  'OpenClaw sticky session reuses explicit session id',
);

console.log('\n8. Chat session continuation state');

globalThis.document = {
  getElementById() { return null; },
  addEventListener() {},
  querySelector() { return null; },
  body: { style: {} },
};
globalThis.window = { document: globalThis.document };
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

const {
  formatSessionRecordForMenu,
  resolveAgentSwitchTarget,
  resolveInitialChatAgent,
  shouldContinueAgentSession,
  terminalPromptDispatchPlan,
  textContainsPermissionPrompt,
} = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/public/js/views/chat.mjs')).href
);

assert(
  !shouldContinueAgentSession({ supportsContinuation: true, hasSession: false }),
  'first turn for a continuation-capable agent starts a fresh session',
);
assert(
  shouldContinueAgentSession({ supportsContinuation: true, hasSession: true }),
  'follow-up turn for a continuation-capable agent requests continuation',
);
assert(
  !shouldContinueAgentSession({ supportsContinuation: false, hasSession: true }),
  'agents without continuation support never request continuation',
);

console.log('\n8b. Initial chat agent selection prefers current record ownership');

assert(
  resolveInitialChatAgent({
    availableAgents: ['codex', 'claude'],
    persistedAgent: 'codex',
    preferredAgent: 'codex',
    currentRecord: { agent: 'claude' },
  }) === 'claude',
  'current record agent beats persisted dropdown preference',
);
assert(
  resolveInitialChatAgent({
    availableAgents: ['codex', 'claude'],
    persistedAgent: 'missing',
    preferredAgent: 'claude',
    currentRecord: { agent: 'missing' },
  }) === 'claude',
  'falls back to valid preferred agent when record agent is unavailable',
);

console.log('\n8c. Agent switch keeps transcript attached to owning record');

const chatRecords = [
  { id: 'claude-record', agent: 'claude', updatedAt: 10, messages: [{ role: 'user', text: 'claude history' }] },
  { id: 'codex-record', agent: 'codex', updatedAt: 20, messages: [{ role: 'user', text: 'codex history' }] },
];
assert(
  resolveAgentSwitchTarget({
    currentRecord: chatRecords[0],
    nextAgent: 'codex',
    records: chatRecords,
  })?.id === 'codex-record',
  'switching agents with existing transcript jumps to that agent\'s record instead of mutating current transcript',
);
assert(
  resolveAgentSwitchTarget({
    currentRecord: { id: 'draft', agent: 'claude', updatedAt: 30, messages: [] },
    nextAgent: 'codex',
    records: chatRecords,
  })?.id === 'draft',
  'empty draft record can be rebound to a different agent',
);

console.log('\n9. Approval prompt detection');

assert(
  JSON.stringify(terminalPromptDispatchPlan('claude', 'hello')) === JSON.stringify([
    { data: 'hello\r', delayMs: 0 },
  ]),
  'non-Codex terminal prompt path sends prompt and Enter together'
);
assert(
  JSON.stringify(terminalPromptDispatchPlan('codex', 'hello')) === JSON.stringify([
    { data: 'hello', delayMs: 0 },
    { data: '\r', delayMs: 350 },
  ]),
  'Codex terminal prompt path sends Enter as a delayed second frame'
);

assert(
  textContainsPermissionPrompt('Permission request: run command?'),
  'detects explicit permission request text',
);
assert(
  textContainsPermissionPrompt('Allow this command? (y/n)'),
  'detects y/n approval prompts',
);
assert(
  textContainsPermissionPrompt('Approval required before running this command. Proceed?'),
  'detects approval/proceed prompt text',
);
assert(
  !textContainsPermissionPrompt('plain assistant output with no prompt'),
  'ignores normal assistant output',
);

console.log('\n10. Session menu record formatting');

const menuRecord = formatSessionRecordForMenu({
  id: 'record-1',
  agent: 'claude',
  title: 'Evaluate this role',
  updatedAt: 1_000_000,
}, 1_000_000 + 2 * 60_000);
assert(
  JSON.stringify(menuRecord) === JSON.stringify({
    id: 'record-1',
    title: 'Evaluate this role',
    agent: 'claude',
    updatedLabel: '2m ago',
  }),
  'formats session menu records with relative age',
);

console.log('\n11. Chat transcript persistence sanitization');

const chatUi = await import(
  pathToFileURL(join(ROOT, 'dashboard-web/public/js/views/chatui.mjs')).href
);

chatUi.restoreMessages([
  { role: 'user', text: 'hello' },
  { role: 'assistant', text: 'hi back', agent: 'claude' },
  { role: 'working', text: 'should not persist' },
  { role: 'system', text: 'Connection error', tone: 'error' },
  { role: 'system', text: 'Switching to codex...', tone: 'default' },
  { role: 'system', text: 'Heads up', tone: 'error' },
  { role: 'bogus', text: 'drop me' },
]);

assert(
  JSON.stringify(chatUi.getMessagesSnapshot()) === JSON.stringify([
    { role: 'user', text: 'hello', tone: 'default', agent: '' },
    { role: 'assistant', text: 'hi back', tone: 'default', agent: 'claude' },
    { role: 'system', text: 'Heads up', tone: 'error', agent: '' },
  ]),
  'chat transcript restore drops non-persistable roles, stale connection errors, and preserves valid messages',
);

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
