import { execFileSync, spawn } from 'child_process';
import { platform } from 'os';
import { join } from 'path';
import { accessSync, constants as fsConstants, existsSync, mkdirSync, realpathSync, statSync } from 'fs';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'opencode', 'hermes', 'openclaw'];

// Which agents support resuming the previous one-shot conversation. claude
// and opencode take a sticky --session-id / --session uuid (we control the
// id, fresh uuid = new chat). codex exec resumes via `exec resume --last`.
// hermes exposes --resume / --continue on `chat`; openclaw has --session-id /
// --session-key on `agent`.
export const AGENT_CONTINUATION_SUPPORT = {
  claude: true,
  codex: true,
  opencode: true,
  hermes: true,
  openclaw: true,
};

const currentPlatform = platform();
export const isWin = currentPlatform === 'win32';
export const isMac = currentPlatform === 'darwin';
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

function preferredUserHome() {
  const explicit = process.env.CATABULL_USER_HOME || process.env.CATABULL_HOST_HOME;
  if (explicit) return explicit;
  const terminalCwd = process.env.TERMINAL_CWD || '';
  if (/^\/home\/[^/]+$/.test(terminalCwd)) return terminalCwd;
  const user = process.env.USER || process.env.LOGNAME || '';
  if (user && !isWin) return `/home/${user}`;
  return process.env.HOME || '';
}

function fallbackAgentCandidates(name) {
  const home = process.env.HOME || '';
  return [
    home ? join(home, '.local', 'bin', name) : '',
    home ? join(home, '.npm-global', 'bin', name) : '',
    `/home/linuxbrew/.linuxbrew/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ].filter(Boolean);
}

export function opencodeEnv(root) {
  const userHome = preferredUserHome();
  return {
    ...process.env,
    HOME: userHome || process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || (userHome ? join(userHome, '.config') : process.env.XDG_CONFIG_HOME),
    XDG_DATA_HOME: process.env.XDG_DATA_HOME || (userHome ? join(userHome, '.local', 'share') : process.env.XDG_DATA_HOME),
    XDG_STATE_HOME: process.env.XDG_STATE_HOME || (userHome ? join(userHome, '.local', 'state') : process.env.XDG_STATE_HOME),
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

export function clearMacQuarantine(path) {
  if (!isMac || !path) return false;
  const targets = new Set([path]);
  try { targets.add(realpathSync(path)); } catch {}

  let changed = false;
  for (const target of targets) {
    try {
      execFileSync('xattr', ['-d', 'com.apple.quarantine', target], {
        timeout: 3000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      changed = true;
    } catch {
      // Missing xattr, missing xattr binary, or no permission. Spawn below
      // will still surface the actionable repair hint.
    }
  }
  return changed;
}

export function agentStartFailureMessage(agentName, command, error) {
  const message = error?.message || 'unknown error';
  const data = `Failed to start ${agentName}: ${message}`;
  const shouldHint = !isWin && /(posix_spawn|EACCES|ENOEXEC|permission denied|bad cpu type)/i.test(message);
  if (!shouldHint) return data;
  const commandLabel = command || agentName;
  return `${data}\nThe binary at "${commandLabel}" couldn't be executed. CataBull tried to clear macOS quarantine automatically first. Common remaining causes: the wrong architecture is installed (Intel binary on Apple Silicon, or vice versa), the file is still quarantined (try \`xattr -d com.apple.quarantine "${commandLabel}"\`), or your shell aliases ${agentName} to something the dashboard can't spawn directly. \`which ${agentName}\` should print a real file path; if it shows "aliased to" or empty, reinstall ${agentName} as a real binary.`;
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
    for (const candidate of fallbackAgentCandidates(name)) {
      if (isExecutableFile(candidate)) return candidate;
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
    // Claude print-mode creates a named session with --session-id on the first
    // turn, but follow-up turns must use --resume <id>. Reusing --session-id on
    // an existing session fails with "Session ID ... is already in use."
    if (sessionId) {
      args.push(continueSession ? '--resume' : '--session-id', sessionId);
    }
    if (allowEdits) args.push('--dangerously-skip-permissions');
    return { args, env: process.env, promptVia: 'stdin' };
  }

  if (agentName === 'codex') {
    // --skip-git-repo-check: `codex exec` refuses to run in a directory that
    // isn't a trusted git repo ("Not inside a trusted directory..."). The
    // home workspace (~/.catabull) isn't a git repo, so without this every
    // exec aborts non-zero and the caller surfaces a 502. Harmless when the
    // workspace *is* a git tree (dev/project-tree mode).
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox', 'workspace-write',
      '-c', 'approval_policy="never"',
    ];
    // CataBull wants Codex sessions to always be able to write inside the
    // workspace without human approval prompts, because chat-mode one-shot
    // runs cannot answer interactive confirmations. Keep the sandbox scoped
    // to the workspace instead of escalating to full disk access.
    // Codex exec does not expose a sticky session-id flag in this mode. The
    // modern CLI resumes with a subcommand rather than the removed --continue
    // flag. "-" makes the resumed turn read the prompt from stdin, matching
    // the fresh `codex exec` path below.
    if (continueSession) args.push('resume', '--last', '-');
    return { args, env: process.env, promptVia: 'stdin' };
  }

  if (agentName === 'opencode') {
    const args = ['run', '--format', 'json', '--dir', root];
    // opencode supports resuming a specific prior session via --session once
    // we know the real session id from a previous run. Fall back to
    // --continue only when the dashboard merely knows "there was a prior
    // conversation" but not the concrete session id yet.
    if (sessionId) args.push('--session', sessionId);
    else if (continueSession) args.push('--continue');
    if (allowEdits) args.push('--dangerously-skip-permissions');
    args.push(prompt);
    return { args, env: opencodeEnv(root), promptVia: 'argv' };
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
    const args = ['agent', '--agent', 'main'];
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
  clearMacQuarantine(command);

  if (agentName === 'opencode') {
    // Use opencode's real fullscreen TUI in the raw rail. `run -i` renders a
    // split-footer demo layout that looks broken inside xterm.js and mirrors
    // poorly into the chat transcript. The root `opencode <project>` entrypoint
    // is the documented TUI path.
    const args = [root];
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
  // Codex interactive sessions need the same workspace-write policy as one-shot
  // runs, but with approvals disabled so the chat drawer never deadlocks on an
  // invisible prompt. Hermes uses explicit `chat --yolo` for the same reason.
  const ptyArgs = agentName === 'openclaw'
    ? ['chat']
    : agentName === 'codex'
      ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
      : agentName === 'claude'
        ? ['--dangerously-skip-permissions']
        : agentName === 'hermes'
          ? ['chat', '--yolo']
          : [];
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
  clearMacQuarantine(command);

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
    return { ok: false, error: agentStartFailureMessage(name, command, err) };
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

function shellQuoteSql(value) {
  return String(value).replace(/'/g, "''");
}

function opencodeDbPath(root) {
  return join(root, 'output', 'opencode-xdg-data', 'opencode', 'opencode.db');
}

function latestOpencodeTextFromDb(root, sessionID) {
  if (!sessionID) return '';
  const db = opencodeDbPath(root);
  if (!existsSync(db)) return '';
  const sql = `
    select json_extract(p.data,'$.text')
    from part p
    join message m on m.id = p.message_id
    where p.session_id = '${shellQuoteSql(sessionID)}'
      and json_extract(m.data,'$.role') = 'assistant'
      and json_extract(p.data,'$.type') = 'text'
    order by p.time_created desc
    limit 1;
  `;
  try {
    return execFileSync('sqlite3', [db, sql], {
      encoding: 'utf-8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    try {
      const script = `import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
cur = con.cursor()
row = cur.execute(
  "select json_extract(p.data,'$.text') from part p join message m on m.id = p.message_id where p.session_id = ? and json_extract(m.data,'$.role') = 'assistant' and json_extract(p.data,'$.type') = 'text' order by p.time_created desc limit 1",
  (sys.argv[2],),
).fetchone()
print((row[0] if row and row[0] else ''), end='')`;
      return execFileSync('python3', ['-c', script, db, sessionID], {
        encoding: 'utf-8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  }
}

function extractOpencodeSessionID(raw) {
  if (!raw) return '';
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const sessionID = parsed.sessionID || parsed.session_id || parsed.part?.sessionID || parsed.part?.session_id || '';
      if (sessionID) return String(sessionID).trim();
    } catch {
      // ignore non-JSON lines
    }
  }
  return '';
}

// Opencode 1.16 can emit only a decorative header in `default` format, and
// only `step_start` events in `json` format, even though the assistant text
// lands in its SQLite store. Recover the latest assistant text from that
// session so the chat panel shows the reply instead of `build · big-pickle`.
function unwrapOpencodeReply(raw, root) {
  if (!raw) return raw;
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let sessionID = '';
  const textParts = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      sessionID ||= parsed.sessionID || parsed.session_id || parsed.part?.sessionID || parsed.part?.session_id || '';
      const part = parsed.part || parsed;
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        textParts.push(part.text.trim());
      }
    } catch {
      // Ignore decorative default-format lines.
    }
  }
  if (textParts.length) return textParts.join('\n');
  return latestOpencodeTextFromDb(root, sessionID) || raw;
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

    clearMacQuarantine(command);

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
    proc.on('error', error => finish({ ok: false, error: agentStartFailureMessage(agentName, command, error) }));
    proc.on('close', code => {
      let output = (stdout || '').trim();
      const error = (stderr || '').trim();
      const opencodeSessionId = agentName === 'opencode' ? extractOpencodeSessionID(stdout) : '';
      if (agentName === 'openclaw') output = unwrapOpenclawReply(output);
      if (agentName === 'opencode') output = unwrapOpencodeReply(output, root);
      if (code === 0) return finish({ ok: true, output: output || error || 'No output returned.', sessionId: opencodeSessionId || null });
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
