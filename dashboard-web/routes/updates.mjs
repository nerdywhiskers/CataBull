import { applyGitPull, applyUpdate, checkForUpdates, getUpdateStatus } from '../../lib/update-manager.mjs';
import { requestDashboardRestart } from '../lib/restart-control.mjs';

export default async function (app) {
  const packageRoot = app.packageRoot || app.cataBullRoot;
  const launchContext = app.launchContext || {};
  const updateOpts = launchContext.updateInstallKind ? { installKind: launchContext.updateInstallKind } : {};

  const withRestartCapability = async (promise) => ({
    ...(await promise),
    restartSupported: Boolean(launchContext.restartSupported),
  });

  app.get('/updates/status', async () => withRestartCapability(getUpdateStatus(packageRoot, updateOpts)));

  app.post('/updates/check', async () => withRestartCapability(checkForUpdates(packageRoot, updateOpts)));

  app.post('/updates/apply', async (req, reply) => {
    const result = await applyUpdate(packageRoot, updateOpts);
    if (!result.success) return reply.code(409).send(result);
    return { ...result, restartSupported: Boolean(launchContext.restartSupported) };
  });

  app.post('/updates/git-pull', async (req, reply) => {
    const result = await applyGitPull(packageRoot, updateOpts);
    if (!result.success) return reply.code(409).send(result);
    return { ...result, restartSupported: Boolean(launchContext.restartSupported) };
  });

  app.post('/updates/restart', async (req, reply) => {
    if (!launchContext.restartSupported) {
      return reply.code(409).send({
        success: false,
        message: 'Dashboard restart is only available when launched through the catabull CLI or start.mjs wrapper.',
      });
    }
    reply.raw.on('finish', () => {
      requestDashboardRestart(launchContext);
    });
    return {
      success: true,
      restarting: true,
      message: 'Dashboard restarting. This page will reconnect in a moment.',
    };
  });
}
