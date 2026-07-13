import { parseApplications, loadReportSummary, parsePipeline } from '../lib/parsers.mjs';
import { updateApplicationStatus, skipPipelineItem, unskipPipelineItem, markPipelineApplied, deleteAllPending, deletePendingByUrl, addPendingItem, updatePendingItem, updatePendingContextualScores, canonicalCompanyRoleKey, enforcePipelineConsistency } from '../lib/writers.mjs';
import { readProfile, readProfileMarkdown, readPortals } from '../lib/writers.mjs';
import { scorePostingTitle, rationaleSummary, relevanceInputsFrom } from '../../lib/relevance.mjs';
import { enrichJobUrl } from '../lib/job-url-metadata.mjs';
import { runAgentPrint } from '../lib/agents.mjs';
import { buildContextualScoringPrompt, extractJsonObject, MAX_CONTEXTUAL_POSTINGS, normalizeContextualScores } from '../../lib/contextual-scoring.mjs';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export default async function (app) {
  const root = app.cataBullRoot;

  function pendingWithHeuristicScores() {
    enforcePipelineConsistency(root);
    const apps = parseApplications(root);
    const { pending: rawPending, skipped, expired } = parsePipeline(root);
    const reportedUrls = collectReportUrls(root);

    const appUrls = new Set(apps.map(a => a.jobUrl).filter(Boolean));
    const appKeys = new Set(apps.map(a => canonicalCompanyRoleKey(a.company, a.role)));
    const skippedUrls = new Set(skipped.map(s => s.url));
    const seenPendingKeys = new Set();

    const pending = rawPending.filter(p => {
      const key = canonicalCompanyRoleKey(p.company, p.role);
      if (appUrls.has(p.url)) return false;
      if (reportedUrls.has(p.url)) return false;
      if (skippedUrls.has(p.url)) return false;
      if (appKeys.has(key)) return false;
      if (seenPendingKeys.has(key)) return false;
      seenPendingKeys.add(key);
      return true;
    });

    const profile = readProfile(root);
    const portals = readPortals(root);
    const inputs = relevanceInputsFrom({ profile, portals });

    for (const p of pending) {
      const { score, factors } = scorePostingTitle(p.role, inputs);
      const storedContextualScore = Number.isFinite(p.contextualScore) ? p.contextualScore : null;
      p.relevance = storedContextualScore ?? score;
      p.heuristicRelevance = score;
      p.relevanceFactors = factors;
      p.relevanceRationale = rationaleSummary(factors);
      if (storedContextualScore != null) {
        p.contextualScore = storedContextualScore;
        p.contextualScoreSource = 'llm';
        p.contextualRationale = p.contextualRationale || '';
        p.contextualSignals = Array.isArray(p.contextualSignals) ? p.contextualSignals : [];
      }
    }

    pending.sort((a, b) => b.relevance - a.relevance);
    return { apps, pending, skipped, expired };
  }

  function collectReportUrls(rootDir) {
    const reportsDir = join(rootDir, 'reports');
    if (!existsSync(reportsDir)) return new Set();
    const urls = new Set();
    for (const file of readdirSync(reportsDir)) {
      if (!file.endsWith('.md') || file === '.gitkeep') continue;
      try {
        const text = readFileSync(join(reportsDir, file), 'utf-8');
        const match = text.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/m);
        if (match?.[1]) urls.add(match[1]);
      } catch {}
    }
    return urls;
  }

  app.get('/applications', async () => {
    const { apps, pending, skipped, expired } = pendingWithHeuristicScores();
    for (const a of apps) {
      if (a.reportPath) {
        a.enrichment = loadReportSummary(root, a.reportPath);
      }
    }

    return { applications: apps, total: apps.length, pending, pendingTotal: pending.length, skipped, skippedTotal: skipped.length, expired, expiredTotal: expired.length };
  });

  app.post('/applications/contextual-scores', async (req, reply) => {
    const profile = readProfile(root) || {};
    const agent = profile?.preferences?.agent || req.body?.agent;
    if (!agent) return reply.code(400).send({ error: 'No agent configured' });

    const requestedUrls = new Set(
      (Array.isArray(req.body?.urls) ? req.body.urls : [])
        .map((url) => String(url || '').trim())
        .filter(Boolean)
    );
    const { pending } = pendingWithHeuristicScores();
    const postings = pending
      .filter((p) => requestedUrls.size === 0 || requestedUrls.has(p.url))
      .slice(0, MAX_CONTEXTUAL_POSTINGS);
    if (!postings.length) return { success: true, agent, scores: [] };

    const timeoutMs = 180_000;
    reply.raw.setTimeout(timeoutMs + 30_000);

    const prompt = buildContextualScoringPrompt({
      profile,
      profileMarkdown: readProfileMarkdown(root) || '',
      postings,
    });

    try {
      const out = await runAgentPrint(agent, prompt, root, {
        timeoutMs,
        allowEdits: false,
        rejectOnError: true,
      });
      const payload = extractJsonObject(out.output || '');
      const scores = normalizeContextualScores(payload, postings);
      updatePendingContextualScores(root, scores);
      return { success: true, agent, scores };
    } catch (err) {
      return reply.code(502).send({ error: err.message || String(err), agent });
    }
  });

  app.patch('/applications/:num', async (req, reply) => {
    const { num } = req.params;
    const { status } = req.body || {};
    if (!status) return reply.code(400).send({ error: 'status is required' });

    const apps = parseApplications(root);
    const app_ = apps.find(a => a.num === parseInt(num));
    if (!app_) return reply.code(404).send({ error: 'Application not found' });

    const ok = updateApplicationStatus(root, app_.reportNumber, app_.num, status, app_.trackerRowId);
    if (!ok) return reply.code(500).send({ error: 'Failed to update status' });
    const cleanup = enforcePipelineConsistency(root);
    return { success: true, cleanup };
  });

  app.post('/pipeline/skip', async (req, reply) => {
    const { url } = req.body || {};
    if (!url) return reply.code(400).send({ error: 'url is required' });
    const ok = skipPipelineItem(root, url);
    const cleanup = enforcePipelineConsistency(root);
    return { success: ok, cleanup };
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
    const cleanup = enforcePipelineConsistency(root);
    return { success: true, cleanup };
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
    if (!url) {
      return reply.code(400).send({ error: 'url is required' });
    }
    try {
      // Defensive validation — stops file-injection via newlines or pipes
      // in user-supplied fields.
      if ([url, company, role, location].some((value) => /[\n\r|]/.test(value || ''))) {
        return reply.code(400).send({ error: 'fields must not contain newlines or pipe characters' });
      }
      // Cheap URL sanity check; the parser also requires http(s).
      if (!/^https?:\/\//i.test(url)) {
        return reply.code(400).send({ error: 'url must start with http:// or https://' });
      }

      let finalCompany = String(company || '').trim();
      let finalRole = String(role || '').trim();
      let finalLocation = String(location || '').trim();
      let finalPostedAt = postedAt;

      if (!finalCompany || !finalRole || !finalLocation) {
        try {
          const enriched = await enrichJobUrl(url);
          if (!finalCompany) finalCompany = enriched.company || '';
          if (!finalRole) finalRole = enriched.role || '';
          if (!finalLocation) finalLocation = enriched.location || '';
        } catch {
          // Keep manual fallback behavior — if enrichment fails but the user
          // supplied enough fields, we should still add the item.
        }
      }

      if (!finalCompany || !finalRole) {
        return reply.code(400).send({ error: 'company and role are required (or the URL must expose them for auto-fill)' });
      }

      const existingApps = parseApplications(root);
      const targetKey = canonicalCompanyRoleKey(finalCompany, finalRole);
      if (existingApps.some((app) => canonicalCompanyRoleKey(app.company, app.role) === targetKey)) {
        return reply.code(409).send({ error: 'Role already exists in the pipeline tracker with a later status' });
      }

      const result = addPendingItem(root, { url, company: finalCompany, role: finalRole, postedAt: finalPostedAt, location: finalLocation });
      if (result.duplicate) return reply.code(409).send({ error: 'URL already exists in pipeline.md' });
      enforcePipelineConsistency(root);
      if (!result.added) return reply.code(500).send({ error: 'Failed to add entry' });
      return { success: true, company: finalCompany, role: finalRole, location: finalLocation || null };
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.patch('/pipeline/item', async (req, reply) => {
    const { url, company, role, postedAt, location } = req.body || {};
    if (!url || !company || !role) {
      return reply.code(400).send({ error: 'url, company, and role are required' });
    }
    if ([url, company, role, location].some((value) => /[\n\r|]/.test(value || ''))) {
      return reply.code(400).send({ error: 'fields must not contain newlines or pipe characters' });
    }
    const result = updatePendingItem(root, { url, company, role, postedAt, location });
    if (!result.updated) {
      return reply.code(result.error === 'pending item not found' ? 404 : 400).send({ error: result.error || 'Failed to update pending item' });
    }
    return { success: true };
  });
}
