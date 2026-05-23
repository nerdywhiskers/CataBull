import {
  AGENT_CONTINUATION_SUPPORT,
  SUPPORTED_AGENTS,
  agentPtyConfig,
  detectAgents,
  detectAgentsDetailed,
  runAgentPrint,
  testAgentCommand,
} from '../lib/agents.mjs';

/** Lazily load node-pty so the dashboard works without it. */
let nodePty = null;
async function ensureNodePty() {
  if (!nodePty) {
    nodePty = await import('node-pty');
  }
  return nodePty;
}

// Default timeout for one-shot agent runs from the chat view. Has to cover
// real workloads: a `/catabull deep` run hits WebSearch + writes a report,
// a `/catabull evaluate` reads several files and produces A-G scoring.
// Both routinely take 2-5 minutes; 10 minutes is a safe upper bound.
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
// Hard cap for client-supplied timeoutMs overrides on POST /terminal/run.
export const MAX_RUN_TIMEOUT_MS = 1_800_000;

export default async function (app) {
  const root = app.cataBullRoot;
  // Re-detect on every request rather than caching at server start, so users
  // who install an agent mid-session can click "Re-check" and see it.
  app.get('/terminal/agents', async () => {
    const details = detectAgentsDetailed();
    return {
      agents: details.map(agent => agent.name),
      supported: SUPPORTED_AGENTS,
      details,
      continuationSupport: AGENT_CONTINUATION_SUPPORT,
    };
  });

  app.post('/terminal/test', async (req, reply) => {
    const name = (req.body?.name || '').toLowerCase();
    if (!name) return reply.code(400).send({ ok: false, error: 'name is required' });
    if (!SUPPORTED_AGENTS.includes(name)) return { ok: false, error: 'Unsupported agent' };
    return testAgentCommand(name, root);
  });

  app.post('/terminal/run', async (req, reply) => {
    // HTTP keepalive must outlast the agent timeout; otherwise the socket
    // closes mid-run and the browser sees a network error before the agent
    // has a chance to reply. Pad by 30s.
    const requestedTimeout = Number.parseInt(req.body?.timeoutMs, 10);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, MAX_RUN_TIMEOUT_MS)
      : DEFAULT_RUN_TIMEOUT_MS;
    reply.raw.setTimeout(timeoutMs + 30_000);

    const agentName = (req.body?.agent || '').toLowerCase();
    const prompt = String(req.body?.prompt || '').trim();
    const continueSession = Boolean(req.body?.continueSession) && Boolean(AGENT_CONTINUATION_SUPPORT[agentName]);
    const rawSessionId = String(req.body?.sessionId || '').trim();
    // Only accept canonical UUIDs to avoid passing arbitrary user input as a
    // CLI arg.
    const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSessionId)
      ? rawSessionId.toLowerCase()
      : null;

    if (!agentName || !SUPPORTED_AGENTS.includes(agentName)) {
      return reply.code(400).send({ ok: false, error: 'supported agent is required' });
    }
    if (!prompt) {
      return reply.code(400).send({ ok: false, error: 'prompt is required' });
    }

    const available = detectAgents();
    if (!available.includes(agentName)) {
      return reply.code(404).send({ ok: false, error: `Agent "${agentName}" not found on PATH.` });
    }

    return runAgentPrint(agentName, prompt, root, { timeoutMs, continueSession, sessionId });
  });

  app.get('/terminal/ws', { websocket: true }, async (socket, req) => {
    const available = detectAgents();
    const agentName = req.query.agent || available[0] || 'claude';

    if (!available.includes(agentName)) {
      socket.send(JSON.stringify({ type: 'error', data: `Agent "${agentName}" not found. Available: ${available.join(', ')}` }));
      socket.close();
      return;
    }

    const cols = parseInt(req.query.cols) || 120;
    const rows = parseInt(req.query.rows) || 40;

    const cfg = agentPtyConfig(agentName, root);
    if (!cfg) {
      socket.send(JSON.stringify({ type: 'error', data: `Agent "${agentName}" could not be started.` }));
      socket.close();
      return;
    }

    let pty;
    try {
      const ptyMod = await ensureNodePty();
      pty = ptyMod.default.spawn(cfg.command, cfg.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: root,
        env: cfg.env,
      });
    } catch (error) {
      // posix_spawnp failures bubble up as cryptic errors. Surface the
      // resolved binary path and the most likely fixes (macOS quarantine,
      // broken alias) so the user can act on it.
      const isPosixSpawn = /posix_spawn/i.test(error?.message || '');
      const hint = isPosixSpawn
        ? `\nThe binary at "${cfg.command}" couldn't be executed. Common causes on macOS: the file is quarantined (try \`xattr -d com.apple.quarantine "${cfg.command}"\`), the wrong architecture is installed (Intel binary on Apple Silicon, or vice versa), or your shell aliases ${agentName} to something the dashboard can't spawn directly. \`which ${agentName}\` should print a real file path; if it shows "aliased to" or empty, reinstall ${agentName} as a real binary.`
        : '';
      const data = `Failed to start ${agentName}: ${error?.message || 'unknown error'}${hint}`;
      socket.send(JSON.stringify({ type: 'error', data }));
      socket.close();
      return;
    }

    let alive = true;

    pty.onData((data) => {
      if (alive) {
        try { socket.send(JSON.stringify({ type: 'output', data })); } catch { /* ok */ }
      }
    });

    pty.onExit(({ exitCode }) => {
      alive = false;
      try { socket.send(JSON.stringify({ type: 'exit', code: exitCode })); } catch { /* ok */ }
      try { socket.close(); } catch { /* ok */ }
    });

    socket.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString());
        if (parsed.type === 'input') {
          pty.write(parsed.data);
        } else if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
          pty.resize(parsed.cols, parsed.rows);
        }
      } catch { /* ignore malformed messages */ }
    });

    socket.on('close', () => {
      alive = false;
      try { pty.kill('SIGTERM'); } catch { /* ok */ }
      // Escalate to SIGKILL if the PTY child doesn't exit within 5s. node-pty
      // routes the signal to the spawned process; ignored on win32 where
      // taskkill is used internally.
      setTimeout(() => { try { pty.kill('SIGKILL'); } catch { /* ok */ } }, 5000);
    });
  });
}
