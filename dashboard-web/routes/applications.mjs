import { parseApplications, loadReportSummary, parsePipeline } from '../lib/parsers.mjs';
import { updateApplicationStatus, skipPipelineItem, unskipPipelineItem, markPipelineApplied, deleteAllPending, deletePendingByUrl, addPendingItem } from '../lib/writers.mjs';
import { readProfile, readPortals } from '../lib/writers.mjs';
import { scorePostingTitle, rationaleSummary, relevanceInputsFrom } from '../../lib/relevance.mjs';

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/applications', async () => {
    const apps = parseApplications(root);
    for (const a of apps) {
      if (a.reportPath) {
        a.enrichment = loadReportSummary(root, a.reportPath);
      }
    }
    const { pending: rawPending, skipped, expired } = parsePipeline(root);

    // Dedup: filter out pending items that already exist in applications (by URL or company+role)
    const appUrls = new Set(apps.map(a => a.jobUrl).filter(Boolean));
    const appKeys = new Set(apps.map(a => `${a.company.toLowerCase()}||${a.role.toLowerCase()}`));
    const skippedUrls = new Set(skipped.map(s => s.url));

    const pending = rawPending.filter(p => {
      if (appUrls.has(p.url)) return false;
      if (skippedUrls.has(p.url)) return false;
      if (appKeys.has(`${p.company.toLowerCase()}||${p.role.toLowerCase()}`)) return false;
      return true;
    });

    // Score relevance of pending items against profile and portals.
    // Pure-heuristic via lib/relevance.mjs (no LLM tokens). Surfaces
    // both the score AND a rationale so the UI can show *why* a posting
    // got its score, not just the number.
    const profile = readProfile(root);
    const portals = readPortals(root);
    const inputs = relevanceInputsFrom({ profile, portals });

    for (const p of pending) {
      const { score, factors } = scorePostingTitle(p.role, inputs);
      p.relevance = score;
      p.relevanceFactors = factors;
      p.relevanceRationale = rationaleSummary(factors);
    }

    // Sort pending by relevance (highest first)
    pending.sort((a, b) => b.relevance - a.relevance);

    return { applications: apps, total: apps.length, pending, pendingTotal: pending.length, skipped, skippedTotal: skipped.length, expired, expiredTotal: expired.length };
  });

  app.patch('/applications/:num', async (req, reply) => {
    const { num } = req.params;
    const { status } = req.body || {};
    if (!status) return reply.code(400).send({ error: 'status is required' });

    const apps = parseApplications(root);
    const app_ = apps.find(a => a.num === parseInt(num));
    if (!app_) return reply.code(404).send({ error: 'Application not found' });

    const ok = updateApplicationStatus(root, app_.reportNumber, app_.num, status);
    if (!ok) return reply.code(500).send({ error: 'Failed to update status' });
    return { success: true };
  });

  app.post('/pipeline/skip', async (req, reply) => {
    const { url } = req.body || {};
    if (!url) return reply.code(400).send({ error: 'url is required' });
    const ok = skipPipelineItem(root, url);
    return { success: ok };
  });

  app.post('/pipeline/unskip', async (req, reply) => {
    const { url } = req.body || {};
    if (!url) return reply.code(400).send({ error: 'url is required' });
    const ok = unskipPipelineItem(root, url);
    return { success: ok };
  });

  app.post('/pipeline/apply', async (req, reply) => {
    const { url, company, role } = req.body || {};
    if (!url || !company || !role) return reply.code(400).send({ error: 'url, company, and role are required' });
    markPipelineApplied(root, url, company, role);
    return { success: true };
  });

  app.post('/pipeline/delete-pending', async () => {
    const removed = deleteAllPending(root);
    return { success: true, removed };
  });

  app.post('/pipeline/delete', async (req, reply) => {
    const { urls } = req.body || {};
    if (!Array.isArray(urls) || !urls.length) {
      return reply.code(400).send({ error: 'urls must be a non-empty array' });
    }
    const removed = deletePendingByUrl(root, urls);
    return { success: true, removed };
  });

  app.post('/pipeline/add', async (req, reply) => {
    const { url, company, role, postedAt, location } = req.body || {};
    if (!url || !company || !role) {
      return reply.code(400).send({ error: 'url, company, and role are required' });
    }
    try {
      // Defensive validation — stops file-injection via newlines or pipes
      // in user-supplied fields.
      if (/[\n\r|]/.test(url) || /[\n\r|]/.test(company) || /[\n\r|]/.test(role)) {
        return reply.code(400).send({ error: 'fields must not contain newlines or pipe characters' });
      }
      // Cheap URL sanity check; the parser also requires http(s).
      if (!/^https?:\/\//i.test(url)) {
        return reply.code(400).send({ error: 'url must start with http:// or https://' });
      }
      const result = addPendingItem(root, { url, company, role, postedAt, location });
      if (result.duplicate) return reply.code(409).send({ error: 'URL already exists in pipeline.md' });
      if (!result.added) return reply.code(500).send({ error: 'Failed to add entry' });
      return { success: true };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
