#!/usr/bin/env node

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

console.log('\nAgent integration helpers');

const { agentPrintArgs, agentPtyConfig, opencodeEnv } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'lib', 'agents.mjs')).href
);

const opencodeResumeArgs = agentPrintArgs('opencode', ROOT, {
  prompt: 'say only ok',
  continueSession: true,
  sessionId: 'session-123',
});
assert(opencodeResumeArgs.args.includes('--session'), 'opencode one-shot resumes a concrete prior session when session id is known');
assert(!opencodeResumeArgs.args.includes('--continue'), 'opencode prefers --session over global --continue when session id is known');

const opencodeFallbackArgs = agentPrintArgs('opencode', ROOT, {
  prompt: 'say only ok',
  continueSession: true,
  sessionId: null,
});
assert(opencodeFallbackArgs.args.includes('--continue'), 'opencode still falls back to --continue when no concrete session id exists yet');

const opencodePty = agentPtyConfig('opencode', ROOT);
assert(Array.isArray(opencodePty?.args) && opencodePty.args.length === 1 && opencodePty.args[0] === ROOT, 'opencode raw terminal launches the documented root TUI entrypoint with the project path');

const opencodeRuntimeEnv = opencodeEnv(ROOT);
assert(opencodeRuntimeEnv.HOME === '/home/jonathan', 'opencode integration uses the host user home instead of the Hermes profile-scoped home');
assert(opencodeRuntimeEnv.XDG_CONFIG_HOME === '/home/jonathan/.config', 'opencode integration keeps the user config directory so providers stay available');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
