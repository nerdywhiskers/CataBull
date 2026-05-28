import { execFileSync, spawn } from 'child_process';
import { platform } from 'os';
import { join } from 'path';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync } from 'fs';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'opencode', 'gemini', 'hermes', 'openclaw'];

// Which agents support resuming the previous one-shot conversation. claude
// and opencode take a sticky --session-id / --session uuid (we control the
// id, fresh uuid = new chat). codex exec resumes via `exec resume --last`.
// gemini's -p mode has no equivalent yet. hermes exposes --resume / --continue
// on `chat`; openclaw has --session-id / --session-key on `agent`. Both stay
// false here until the dashboard chooses a resume policy and threads ids in.
export const AGENT_CONTINUATION_SUPPORT = {
  claude: true,
  codex: true,
  opencode: true,
  gemini: false,
  hermes: true,
  openclaw: true,
};

export const isWin = platform() === 'win32';
const loginShell = process.env.SHELL || '/bin/bash';

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function winShell(command, args = []) {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-Command', ['&', psQuote(command), ...args.map(psQuote)].join(' ')],
  };
}

function winPreferCmdShim(command) {
  if (!isWin || !command || /\.[a-z0-9]+$/i.test(command)) return command;
  const cmdPath = `${command}.cmd`;
  return existsSync(cmdPath) ? cmdPath : command;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function opencodeEnv(root) {
  const outputRoot = ensureDir(join(root, 'output'));
  return {
    ...process.env,
    XDG_CONFIG_HOME: ensureDir(join(outputRoot, 'opencode-xdg-config')),
    XDG_DATA_HOME: ensureDir(join(outputRoot, 'opencode-xdg-data')),
    XDG_STATE_HOME: ensureDir(join(outputRoot, 'opencode-xdg-state')),
  };
}

// Confirm the candidate path actually points to an executable file we can
// spawn directly. zsh's `command -v` can return alias text (e.g.
// "claude: aliased to /opt/claude/bin/claude") for aliased commands, and
// node-pty's posix_spawnp fails opaquely on those. Same for binaries that
// got macOS-quarantined or have a wrong-arch interpreter — those file-stat
// fine but exec fails. We can't catch every case, but a real-file +
// executable-bit check rules out the most common ones.
function isExecutableFile(path) {
  if (!path) return false;
  try {
    if (!statSync(path).isFile()) return false;
    if (!isWin) accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgentCommand(name) {
  if (!SUPPORTED_AGENTS.includes(name)) return null;

  try {
    if (isWin) {
      const out = execFileSync('where', [name], { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
      const candidates = out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const cmdShim = candidates.find(line => line.toLowerCase().endsWith('.cmd'));
      const resolved = cmdShim || winPreferCmdShim(candidates[0]) || null;
      return isExecutableFile(resolved) ? resolved : null;
    }

    // Prefer bash for resolution. zsh's `command -v` returns alias text
    // ("claude: aliased to ...") for aliased commands, which is unspawnable;
    // bash's command -v always returns a path or empty.
    const shellsToTry = ['/bin/bash', loginShell].filter((s, i, a) => s && a.indexOf(s) === i);
    for (const shell of shellsToTry) {
      try {
        const out = execFileSync(shell, ['-lc', `command -v ${name} 2>/dev/null`], {
          encoding: 'utf-8',
          timeout: 8000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const candidate = out.trim().split('\n')[0];
        if (isExecutableFile(candidate)) return candidate;
      } catch {
        // try next shell
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function detectAgentsDetailed() {
  return SUPPORTED_AGENTS
    .map(name => ({ name, command: resolveAgentCommand(name) }))
    .filter(agent => agent.command);
}

export function detectAgents() {
  return detectAgentsDetailed().map(agent => agent.name);
}

// `promptVia` tells runAgentPrint how to deliver the prompt:
//   - 'stdin' (default): write the prompt to the child's stdin and close it.
//   - 'argv': prompt is already embedded in `args` (via a flag like
//     `-q`/`--message`). runAgentPrint must NOT write stdin in that case
//     — these CLIs don't read prompts from stdin and will hang or error.
export function agentPrintArgs(agentName, root, { allowEdits = false, sessionId = null, continueSession = false, prompt = '' } = {}) {
  if (agentName === 'claude') {
    const args = ['-p', '--output-format', 'text'];
    // claude -p without flags defaults to continuing the most-recent session
    // for this cwd. Pin to an explicit session id so the client can switch
    // conversations on demand (Reset → new uuid → fresh session).
    if (sessionId) args.push('--session-id', sessionId);
    if (allowEdits) args.push('--permission-mode', 'acceptEdits');
    return { args, env: process.env, promptVia: 'stdin' };
  }

  if (agentName === 'codex') {
    // --skip-git-repo-check: `codex exec` refuses to run in a directory that
    // isn't a trusted git repo ("Not inside a trusted directory..."). The
    // home workspace (~/.catabull) isn't a git repo, so without this every
    // exec aborts non-zero and the caller surfaces a 502. Harmless when the
    // workspace *is* a git tree (dev/project-tree mode).
    const args = ['exec', '--skip-git-repo-check'];
    // --full-auto grants the workspace-write sandbox codex needs to edit
    // files (profile.yml, modes/_profile.md) during generation. Read-only
    // steps (e.g. JSON CV extraction) don't pass allowEdits and stay in the
    // default read-only sandbox.
    if (allowEdits) args.push('--full-auto');
    // Codex exec does not expose a sticky session-id flag in this mode. The
    // modern CLI resumes with a subcommand rather than the removed --continue
    // flag. "-" makes the resumed turn read the prompt from stdin, matching
    // the fresh `codex exec` path below.
    if (continueSession) args.push('resume', '--last', '-');
    return { args, env: process.env, promptVia: 'stdin' };
  }

  if (agentName === 'opencode') {
    const args = ['run', '--pure', '--format', 'default', '--dir', root];
    // opencode's --session expects an EXISTING session id (silently no-ops
    // on an unknown uuid), so we can't use the sticky-uuid pattern claude
    // supports. Fall back to --continue, which resumes "the last session"
    // — fine for a single-user dashboard. Reset = drop the seen flag so
    // the next call omits --continue and a new session is created.
    if (continueSession) args.push('--continue');
    return { args, env: opencodeEnv(root), promptVia: 'stdin' };
  }

  if (agentName === 'gemini') {
    // Gemini runs headless when stdin is piped (non-TTY) and reads the prompt
    // from stdin. The -p/--prompt flag instead expects an *inline* value
    // (`gemini -p "<prompt>"`) and errors "Not enough arguments following: p"
    // when the prompt is on stdin — and inline args choke on large prompts —
    // so we omit it and let stdin carry the prompt. --skip-trust bypasses the
    // trusted-folder check that otherwise aborts in the (non-git) home
    // workspace.
    const args = ['--skip-trust'];
    // --yolo auto-approves tool calls so the agent can write files
    // (profile.yml, modes/_profile.md) during generation. Read-only steps
    // don't pass allowEdits and stay approval-gated.
    if (allowEdits) args.push('--yolo');
    return { args, env: process.env, promptVia: 'stdin' };
  }

  if (agentName === 'hermes') {
    // Verified against hermes --help on a real install:
    //   - `hermes chat -q <prompt>` is the one-shot/non-interactive path
    //     (`-q/--query` takes the prompt inline; subcommand is required).
    //   - `-Q/--quiet` suppresses banner/spinner so we get clean output.
    //   - `--yolo` bypasses approval prompts (needed when allowEdits-ish
    //     workflows touch the FS).
    //   - `--continue` resumes the most recent chat session. The dashboard
    //     uses that for follow-up turns and drops the seen marker on Reset so
    //     the next message starts a fresh session.
    // hermes does not read prompts from stdin in this mode, so promptVia
    // must be 'argv' — runAgentPrint will close stdin without writing.
    const args = ['chat'];
    if (continueSession) args.push('--continue');
    args.push('-q', prompt, '-Q', '--yolo');
    return {
      args,
      env: process.env,
      promptVia: 'argv',
    };
  }

  if (agentName === 'openclaw') {
    // Verified against `openclaw agent --help` and live runs on a real
    // install:
    //   - `openclaw agent` runs one agent turn via the Gateway, using the
    //     user's configured auth profile (openai-codex, anthropic, etc.).
    //   - A target session must be picked. `--agent main` targets the
    //     default agent openclaw bootstraps on first install (visible as
    //     "main (default)" in `openclaw agents list`). Users who renamed
    //     or removed it will need to adjust here.
    //   - `--session-id <uuid>` lets the dashboard pin follow-up turns to its
    //     own browser-owned sticky session instead of colliding with whatever
    //     default routing context OpenClaw would otherwise choose.
    //   - `--message` carries the prompt inline (no stdin path exists).
    //   - `--no-color` keeps stdout ANSI-free.
    //   - `--json` is required: the default (human) output path stalls
    //     without a TTY and produced no stdout in 90+ seconds in
    //     headless tests. `--json` emits a structured envelope quickly
    //     and reliably. The envelope is unwrapped in runAgentPrint
    //     (see unwrapOpenclawReply) so downstream callers see only the
    //     assistant's reply text, matching every other agent.
    //   - `--local` is NOT used: per --help it requires raw provider API
    //     keys in the shell env, bypassing openclaw's own config. Gateway
    //     mode is the documented normal path. (The previous `--agent`
    //     with no value was a bug — `--agent <id>` requires a value.)
    const args = ['--no-color', 'agent', '--agent', 'main'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push('--message', prompt, '--json');
    return {
      args,
      env: process.env,
      promptVia: 'argv',
    };
  }

  return null;
}

export function agentPtyConfig(agentName, root) {
  const command = resolveAgentCommand(agentName);
  if (!command) return null;

  if (agentName === 'opencode') {
    const args = ['--pure'];
    const shell = isWin ? winShell(command, args) : { command, args };
    return {
      command: shell.command,
      args: shell.args,
      env: {
        ...opencodeEnv(root),
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
        CLICOLOR_FORCE: '1',
      },
    };
  }

  // OpenClaw's conversational entrypoint is `openclaw chat`, not the
  // bare binary (confirmed). Without the subcommand the CLI prints
  // help and exits, which the rail surfaces as an immediate disconnect.
  const ptyArgs = agentName === 'openclaw' ? ['chat'] : [];
  const shell = isWin ? winShell(command, ptyArgs) : { command, args: ptyArgs };
  return {
    command: shell.command,
    args: shell.args,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
    },
  };
}

export function testAgentCommand(name, root = process.cwd()) {
  const command = resolveAgentCommand(name);
  if (!command) return { ok: false, error: `Agent "${name}" not found on PATH.` };

  try {
    const env = name === 'opencode' ? opencodeEnv(root) : process.env;
    const shell = isWin ? winShell(command, ['--version']) : { command, args: ['--version'] };
    const out = isWin
      ? execFileSync(shell.command, shell.args, {
        encoding: 'utf-8',
        timeout: 8000,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      : execFileSync(shell.command, shell.args, {
      encoding: 'utf-8',
      timeout: 8000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      });
    return { ok: true, version: (out || '').trim().split('\n')[0] };
  } catch (err) {
    return { ok: false, error: err.message || 'Command failed' };
  }
}

// Pull the assistant's reply out of openclaw's `--json` envelope so
// callers see plain reply text — same shape every other agent returns.
// Envelope shape (verified live):
//   { runId, status, result: { payloads: [{text, mediaUrl}], meta: {...} } }
// `result.payloads[0].text` is the published reply path. We fall back to
// `meta.agentMeta.execution.finalAssistantVisibleText` for robustness,
// and finally to the raw stdout if the envelope can't be parsed (so a
// future schema bump fails open rather than silently dropping output).
function unwrapOpenclawReply(raw) {
  if (!raw) return raw;
  try {
    const parsed = JSON.parse(raw);
    const fromPayload = parsed?.result?.payloads?.[0]?.text;
    if (typeof fromPayload === 'string' && fromPayload.length) return fromPayload;
    const fromMeta = parsed?.result?.meta?.agentMeta?.execution?.finalAssistantVisibleText;
    if (typeof fromMeta === 'string' && fromMeta.length) return fromMeta;
    return raw;
  } catch {
    return raw;
  }
}

export function runAgentPrint(agentName, prompt, root, {
  timeoutMs = 120_000,
  allowEdits = false,
  rejectOnError = false,
  continueSession = false,
  sessionId = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const command = resolveAgentCommand(agentName);
    const plan = agentPrintArgs(agentName, root, { allowEdits, continueSession, sessionId, prompt });

    const fail = (payload) => {
      if (rejectOnError) reject(new Error(payload.error));
      else resolve(payload);
    };

    if (!command || !plan) {
      fail({ ok: false, error: `Agent "${agentName}" not found on PATH.` });
      return;
    }

    const shell = isWin ? winShell(command, plan.args) : { command, args: plan.args };

    const proc = spawn(shell.command, shell.args, {
      cwd: root,
      env: plan.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (rejectOnError && !payload.ok) reject(new Error(payload.error));
      else resolve(payload);
    };

    proc.stdout.on('data', data => { stdout += data; });
    proc.stderr.on('data', data => { stderr += data; });
    proc.on('error', error => finish({ ok: false, error: error.message || `Failed to start ${agentName}` }));
    proc.on('close', code => {
      let output = (stdout || '').trim();
      const error = (stderr || '').trim();
      if (agentName === 'openclaw') output = unwrapOpenclawReply(output);
      if (code === 0) return finish({ ok: true, output: output || error || 'No output returned.' });
      return finish({ ok: false, error: error || output || `${agentName} exited with code ${code}` });
    });

    timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      finish({ ok: false, error: `${agentName} timed out after ${Math.round((timeoutMs || 0) / 1000)} seconds` });
    }, timeoutMs);

    try {
      if (plan.promptVia === 'argv') {
        // Prompt is already in argv (hermes -q, openclaw --message).
        // These CLIs don't read stdin in one-shot mode; closing stdin
        // immediately avoids any chance of them blocking on EOF.
        proc.stdin.end();
      } else {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }
    } catch (error) {
      finish({ ok: false, error: error.message || `Failed to send prompt to ${agentName}` });
    }
  });
}
