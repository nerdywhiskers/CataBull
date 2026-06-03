import { spawn } from 'child_process';
import { join } from 'path';
import { getStatus, getSchedule, setSchedule, runScan, restartScheduler } from '../lib/scheduler.mjs';
import { parsePipeline } from '../lib/parsers.mjs';
import { expirePipelineItem } from '../lib/writers.mjs';
import { createLineBuffer, parseProgressLine } from '../lib/scan-progress-stream.mjs';
import { finishScanRun, readScanRunState, startScanRun, updateScanRun } from '../lib/scan-run-state.mjs';
import { spawnWithTimeout } from '../lib/spawn-timeout.mjs';

// Alias for backwards compatibility with internal callers.
const runNodeScript = spawnWithTimeout;

// Parse check-liveness.mjs output: each line is "url\tstatus\tdetail".
function parseLivenessOutput(stdout) {
  const results = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0].startsWith('http')) {
      results.push({ url: parts[0], status: parts[1], detail: parts[2] || '' });
    }
  }
  return results;
}

function mapQuickProgress(payload = {}) {
  if (payload.type === 'run:start') return { stage: 'quick:scanning', companies: payload.companies || 0 };
  if (payload.type === 'company:start') return {
    stage: 'quick:company:start',
    company: payload.company,
    provider: payload.provider,
    index: payload.index,
    total: payload.total,
  };
  if (payload.type === 'company:done') return {
    stage: 'quick:company:done',
    company: payload.company,
    provider: payload.provider,
    index: payload.index,
    total: payload.total,
    found: payload.found,
    added: payload.added,
    error: payload.error,
    durationMs: payload.durationMs,
  };
  if (payload.type === 'run:complete') return {
    stage: 'quick:done',
    companies: payload.companies,
    totalFound: payload.totalFound,
    added: payload.added,
    errors: payload.errors,
    durationMs: payload.durationMs,
  };
  return null;
}

export default async function (app) {
  const root = app.cataBullRoot;
  // Helper scripts live in the package, not the user's workspace (the two
  // differ in a ~/.catabull home install). Launch from packageRoot and tell
  // the script which workspace to operate on via CATABULL_WORKSPACE_ROOT.
  const packageRoot = app.packageRoot;
  const scriptEnv = { ...process.env, CATABULL_WORKSPACE_ROOT: root };

  // Manual scan (legacy endpoint)
  app.post('/actions/scan', async (req) => {
    const dryRun = req.body?.dryRun || false;
    const extraArgs = ['--mode', 'quick', ...(dryRun ? ['--dry-run'] : [])];
    return runNodeScript(join(packageRoot, 'scan.mjs'), extraArgs, { cwd: root, timeoutMs: 120000, env: scriptEnv });
  });

  // Scan scheduler endpoints
  app.get('/scan/status', async () => {
    return getStatus(root);
  });

  app.get('/scan/run-state', async () => {
    return readScanRunState(root);
  });

  app.put('/scan/schedule', async (req) => {
    const { schedule } = req.body;
    if (!['off', 'daily', 'every-3-days', 'weekly'].includes(schedule)) {
      return { error: 'Invalid schedule. Use: off, daily, every-3-days, weekly' };
    }
    setSchedule(root, schedule);
    restartScheduler(root);
    return { success: true, ...getStatus(root) };
  });

  app.post('/scan/run', async (req, reply) => {
    reply.raw.setTimeout(300000);
    const limit = parseInt(req.body?.limit, 10);
    const result = await runScan(root, { limit: Number.isFinite(limit) && limit > 0 ? limit : 0 });
    return result;
  });

  app.get('/scan/run/stream', async (req, reply) => {
    const limit = parseInt(req.query?.limit, 10);
    const args = [join(packageRoot, 'scan.mjs'), '--mode', 'quick', '--progress'];
    if (Number.isFinite(limit) && limit > 0) args.push('--limit', String(limit));

    startScanRun(root, {
      mode: 'quick',
      stage: 'quick:start',
      progress: { stage: 'quick:start' },
    });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();

    const send = (event, payload) => {
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {}
    };

    const child = spawn(process.execPath, args, { cwd: root, env: scriptEnv });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const closeChild = () => {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
    };

    reply.raw.on('close', () => {
      if (!finished) closeChild();
    });

    const handleLine = (line) => {
      const payload = parseProgressLine(line);
      if (!payload) return;
      const mapped = mapQuickProgress(payload);
      if (mapped) {
        updateScanRun(root, { stage: mapped.stage, progress: mapped });
        send('progress', mapped);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const progressFromStdout = createLineBuffer(handleLine);
    child.stdout.on('data', progressFromStdout);
    const progressFromStderr = createLineBuffer(handleLine);
    child.stderr.on('data', progressFromStderr);

    child.on('error', (err) => {
      finished = true;
      finishScanRun(root, { mode: 'quick', status: 'failed', error: err.message || String(err) });
      send('error', { message: err.message || String(err) });
      reply.raw.end();
    });

    child.on('close', (code) => {
      finished = true;
      const added = parseInt((stdout.match(/New offers added:\s+(\d+)/)?.[1]) || '0', 10);
      if (code !== 0) {
        finishScanRun(root, { mode: 'quick', status: 'failed', error: stderr || stdout || `Quick scan failed (${code})` });
        send('error', { message: stderr || stdout || `Quick scan failed (${code})` });
        reply.raw.end();
        return;
      }
      finishScanRun(root, { mode: 'quick', status: 'completed', summary: { totalNew: added, quick: { added } } });
      send('complete', { summary: { quick: { added, stdout, stderr }, totalNew: added } });
      reply.raw.end();
    });
  });

  app.post('/scan/diagnose', async (req, reply) => {
    reply.raw.setTimeout(300000);
    const limit = parseInt(req.body?.limit, 10);
    const args = ['--dry-run', '--json', '--diagnose'];
    if (Number.isFinite(limit) && limit > 0) args.push('--limit', String(limit));
    const result = await runNodeScript(join(packageRoot, 'scan.mjs'), args, { cwd: root, timeoutMs: 300000, env: scriptEnv });
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr || result.stdout || 'Scan diagnostics failed' };
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      return { success: false, error: 'Scan diagnostics returned invalid JSON' };
    }
  });

  // Liveness check — verify if pending job URLs are still active
  app.post('/liveness/check', async (req, reply) => {
    reply.raw.setTimeout(300000);
    const urls = req.body?.urls;
    if (!urls || !urls.length) return reply.code(400).send({ error: 'urls array is required' });

    const result = await runNodeScript(join(packageRoot, 'check-liveness.mjs'), urls, { cwd: root, timeoutMs: 300000, env: scriptEnv });
    if (result.exitCode === -1) return { results: [], error: 'Timed out' };
    if (result.exitCode === -2) return { results: [], error: result.stderr.trim() };
    return { results: parseLivenessOutput(result.stdout + result.stderr) };
  });

  // Mark a URL as expired
  app.post('/liveness/expire', async (req, reply) => {
    const { url } = req.body || {};
    if (!url) return reply.code(400).send({ error: 'url is required' });
    const ok = expirePipelineItem(root, url);
    return { success: ok };
  });

  // Check liveness of all pending URLs and auto-expire dead ones
  app.post('/liveness/check-all', async (req, reply) => {
    reply.raw.setTimeout(600000);
    const { pending } = parsePipeline(root);
    if (!pending.length) return { checked: 0, expired: 0, results: [] };

    const urls = pending.map(p => p.url);

    const result = await runNodeScript(join(packageRoot, 'check-liveness.mjs'), urls, { cwd: root, timeoutMs: 600000, env: scriptEnv });
    if (result.exitCode === -1) return { checked: 0, expired: 0, error: 'Timed out' };
    if (result.exitCode === -2) return { checked: 0, expired: 0, error: result.stderr.trim() };

    const results = parseLivenessOutput(result.stdout + result.stderr);
    let expiredCount = 0;
    for (const r of results) {
      if (r.status === 'expired' || r.status === 'closed') {
        expirePipelineItem(root, r.url);
        expiredCount++;
      }
    }
    return { checked: urls.length, expired: expiredCount, results };
  });
}
