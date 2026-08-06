#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';

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
const { buildDashboardAgentPrompt, inspectGitContext } = await import(
  pathToFileURL(join(ROOT, 'dashboard-web', 'routes', 'terminal.mjs')).href
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
if (opencodePty) {
  assert(Array.isArray(opencodePty.args) && opencodePty.args.length === 1 && opencodePty.args[0] === ROOT, 'opencode raw terminal launches the documented root TUI entrypoint with the project path');
} else {
  // CI doesn't have opencode installed — skip pty assertions
}

const opencodeRuntimeEnv = opencodeEnv(ROOT);
assert(typeof opencodeRuntimeEnv.HOME === 'string' && opencodeRuntimeEnv.HOME.length > 0, 'opencode integration uses a real host HOME path instead of an empty or profile-scoped value');
assert(opencodeRuntimeEnv.XDG_CONFIG_HOME === join(opencodeRuntimeEnv.HOME, '.config'), 'opencode integration keeps the user config directory so providers stay available');

const packageGit = inspectGitContext(ROOT);
assert(packageGit.isRepo === true, 'terminal route can inspect the package repo git state');
assert(typeof packageGit.branch === 'string', 'terminal route reports the package repo branch state');
assert(packageGit.branch.length > 0 || packageGit.label.includes('detached'), 'terminal route reports a live branch name or a detached checkout');
assert(packageGit.noCommits === false, 'package repo git state includes a real commit');

const workspacePath = '/home/jonathan/.catabull';
if (workspacePath && existsSync(join(workspacePath, '.git'))) {
  const workspaceGit = inspectGitContext(workspacePath);
  assert(workspaceGit.isRepo === true, 'terminal route inspects the workspace git state when present');
  assert(workspaceGit.branch === 'master', 'workspace git state reflects the uninitialized workspace branch');
  assert(workspaceGit.noCommits === true, 'workspace git state marks zero-commit repos explicitly');
} else {
  // CI doesn't have ~/.catabull — skip workspace assertions
}

const wrappedPrompt = buildDashboardAgentPrompt('What is the current branch in this repo?', {
  workspaceRoot: '/home/jonathan/.catabull',
  packageRoot: ROOT,
  workspaceGit: { label: 'branch master with zero commits' },
  packageGit: { label: 'branch dev at 2953e69' },
});
assert(wrappedPrompt.includes('Workspace root (user data, reports, tracker files): /home/jonathan/.catabull'), 'dashboard prompt wrapper includes the user workspace root');
assert(wrappedPrompt.includes(`Package repo root (dashboard source code): ${ROOT}`), 'dashboard prompt wrapper includes the package repo root');
assert(wrappedPrompt.includes('treat the package repo root as the repo'), 'dashboard prompt wrapper disambiguates branch/repo questions toward the source repo');
assert(wrappedPrompt.endsWith('What is the current branch in this repo?'), 'dashboard prompt wrapper preserves the user prompt verbatim at the end');

const plainPrompt = buildDashboardAgentPrompt('plain prompt', {
  workspaceRoot: ROOT,
  packageRoot: ROOT,
});
assert(plainPrompt === 'plain prompt', 'dashboard prompt wrapper stays out of the way when workspace and package roots match');

console.log(`\nPassed: ${passed} / ${total}`);
if (failed > 0) process.exitCode = 1;
else console.log('All passed ✓');
