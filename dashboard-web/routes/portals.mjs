import { addCompany, deleteCompany, readPortals, toggleCompanyEnabled, updateCompany, writePortals } from '../lib/writers.mjs';
import { perCompanyMetrics } from '../lib/metrics.mjs';
import { runScan } from '../lib/scheduler.mjs';
import { listProviders } from '../../scan/providers/index.mjs';

export default async function (app) {
  const root = app.careerBotRoot;
  const findCompany = (name) => readPortals(root)?.tracked_companies?.find(item => item.name.toLowerCase() === name.toLowerCase());

  app.get('/portals', async () => {
    const portals = readPortals(root);
    return { portals };
  });

  app.get('/portals/providers', async () => {
    return { providers: listProviders() };
  });

  app.put('/portals', async (req) => {
    writePortals(root, req.body);
    return { success: true };
  });

  app.patch('/portals/companies/:name', async (req) => {
    const { name } = req.params;
    const { enabled } = req.body;
    toggleCompanyEnabled(root, decodeURIComponent(name), enabled);
    return { success: true };
  });

  app.patch('/portals/filters', async (req) => {
    const portals = readPortals(root);
    if (portals) {
      portals.title_filter = req.body;
      writePortals(root, portals);
    }
    return { success: true };
  });

  app.post('/portals/companies', async (req, reply) => {
    const company = req.body || {};
    if (!company.name || !company.careers_url) {
      return reply.code(400).send({ error: 'name and careers_url are required' });
    }
    if (findCompany(company.name)) {
      return reply.code(409).send({ error: 'A company with that name already exists' });
    }
    addCompany(root, company);
    return { success: true };
  });

  app.put('/portals/companies/:name', async (req, reply) => {
    const existingName = decodeURIComponent(req.params.name);
    const payload = req.body || {};
    if (!payload.name || !payload.careers_url) {
      return reply.code(400).send({ error: 'name and careers_url are required' });
    }
    const conflict = findCompany(payload.name);
    if (conflict && conflict.name.toLowerCase() !== existingName.toLowerCase()) {
      return reply.code(409).send({ error: 'A company with that name already exists' });
    }
    const updated = updateCompany(root, existingName, payload);
    if (!updated) return reply.code(404).send({ error: 'Company not found' });
    return { success: true };
  });

  app.delete('/portals/companies/:name', async (req, reply) => {
    const removed = deleteCompany(root, decodeURIComponent(req.params.name));
    if (!removed) return reply.code(404).send({ error: 'Company not found' });
    return { success: true };
  });

  app.post('/portals/companies/:name/scan', async (req, reply) => {
    reply.raw.setTimeout(300000);
    const limit = parseInt(req.body?.limit, 10);
    const result = await runScan(root, {
      company: decodeURIComponent(req.params.name),
      limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
    });
    return result;
  });

  app.get('/portals/companies/:name/metrics', async (req, reply) => {
    const name = decodeURIComponent(req.params.name);
    const metrics = perCompanyMetrics(root);
    const company = findCompany(name);
    if (!company) return reply.code(404).send({ error: 'Company not found' });
    return { metrics: metrics[name.toLowerCase()] || { lastScannedAt: null, jobsFound: 0, matchRate: 0, pipelineMatches: 0 } };
  });

  // Batch sibling to /portals/companies/:name/metrics. The portals view
  // used to call the per-name endpoint once per tracked company, which
  // re-parsed scan-history.tsv + pipeline.md on every call. This returns
  // the full { [companyName]: metrics } map in a single request — and
  // perCompanyMetrics() is now mtime-cached so back-to-back loads are free.
  app.get('/portals/metrics', async () => {
    const portals = readPortals(root);
    const tracked = portals?.tracked_companies || [];
    const metrics = perCompanyMetrics(root);
    const out = {};
    for (const company of tracked) {
      out[company.name] = metrics[company.name.toLowerCase()] || {
        lastScannedAt: null, jobsFound: 0, matchRate: 0, pipelineMatches: 0,
      };
    }
    return { metrics: out };
  });
}
