import { join } from 'path';
import { parseApplications } from '../lib/parsers.mjs';
import { computeMetrics, computeProgressMetrics } from '../lib/metrics.mjs';
import { spawnWithTimeout } from '../lib/spawn-timeout.mjs';

export default async function (app) {
  const root = app.cataBullRoot;

  function runJsonScript(scriptName, args = []) {
    // Scripts live in the package; point them at the user's workspace via env.
    return spawnWithTimeout(join(app.packageRoot, scriptName), args, {
      cwd: root,
      timeoutMs: 300_000,
      env: { ...process.env, CATABULL_WORKSPACE_ROOT: root },
    })
      .then(result => {
        try {
          return JSON.parse(result.stdout || '{}');
        } catch {
          return { error: result.stderr.trim() || 'Failed to parse script output.' };
        }
      });
  }

  app.get('/metrics', async () => {
    const apps = parseApplications(root);
    return {
      pipeline: computeMetrics(apps),
      progress: computeProgressMetrics(apps),
    };
  });

  app.get('/metrics/patterns', async () => {
    return runJsonScript('analyze-patterns.mjs');
  });

  app.get('/metrics/followup', async () => {
    return runJsonScript('followup-cadence.mjs');
  });
}
