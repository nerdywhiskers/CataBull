import { join } from 'path';
import { getStatus, getSchedule, setSchedule, runScan, restartScheduler } from '../lib/scheduler.mjs';
import { parsePipeline } from '../lib/parsers.mjs';
import { expirePipelineItem } from '../lib/writers.mjs';
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

export default async function (app) {
  const root = app.cataBullRoot;

  // Manual scan (legacy endpoint)
  app.post('/actions/scan', async (req) => {
    const dryRun = req.body?.dryRun || false;
    const extraArgs = dryRun ? ['--dry-run'] : [];
    return runNodeScript(join(root, 'scan.mjs'), extraArgs, { cwd: root, timeoutMs: 120000 });
  });

  // Scan scheduler endpoints
  app.get('/scan/status', async () => {
    return getStatus(root);
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

  app.post('/scan/diagnose', async (req, reply) => {
    reply.raw.setTimeout(300000);
    const limit = parseInt(req.body?.limit, 10);
    const args = ['--dry-run', '--json', '--diagnose'];
    if (Number.isFinite(limit) && limit > 0) args.push('--limit', String(limit));
    const result = await runNodeScript(join(root, 'scan.mjs'), args, { cwd: root, timeoutMs: 300000 });
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

    const result = await runNodeScript(join(root, 'check-liveness.mjs'), urls, { cwd: root, timeoutMs: 300000 });
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

    const result = await runNodeScript(join(root, 'check-liveness.mjs'), urls, { cwd: root, timeoutMs: 600000 });
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
