import { applyGitPull, applyUpdate, checkForUpdates, getUpdateStatus } from '../../lib/update-manager.mjs';

export default async function (app) {
  const packageRoot = app.packageRoot || app.careerBotRoot;

  app.get('/updates/status', async () => getUpdateStatus(packageRoot));

  app.post('/updates/check', async () => checkForUpdates(packageRoot));

  app.post('/updates/apply', async (req, reply) => {
    const result = await applyUpdate(packageRoot);
    if (!result.success) return reply.code(409).send(result);
    return result;
  });

  app.post('/updates/git-pull', async (req, reply) => {
    const result = await applyGitPull(packageRoot);
    if (!result.success) return reply.code(409).send(result);
    return result;
  });
}
