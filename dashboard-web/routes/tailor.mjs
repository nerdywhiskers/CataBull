/**
 * routes/tailor.mjs — One-click Tailor bundle (PR 1.5).
 *
 * POST /tailor
 *   body: { company, role, url?, jd? }
 *   → { success, slug, dir, paths, agent, preview }
 *
 * GET /tailor/file?path=<workspace-relative>
 *   → returns the file content (constrained to output/tailor-bundles/*)
 *   used by the frontend modal to preview / download.
 */

import { runAgentPrint } from '../lib/agents.mjs';
import { runTailor } from '../../lib/tailor.mjs';
import { readProfile } from '../lib/writers.mjs';
import { asWorkspace } from '../../lib/workspace.mjs';

export default async function (app) {
  const root = app.cataBullRoot;

  app.post('/tailor', async (req, reply) => {
    const { company, role, url, jd } = req.body || {};
    if (!company || !role) {
      return reply.code(400).send({ error: 'company and role are required' });
    }

    const profile = readProfile(root) || {};
    const agent = profile?.preferences?.agent || req.body?.agent;
    if (!agent) return reply.code(400).send({ error: 'No agent configured' });

    // Tailor wires together CV + cover letter + Q&A in one agent call.
    // It's expensive (full CV + JD context) but onboarding-style — runs
    // on demand, not on every page load. 6-minute ceiling.
    const timeoutMs = 360_000;
    reply.raw.setTimeout(timeoutMs + 30_000);

    const ws = asWorkspace(root);
    const runAgent = async (prompt) => {
      const out = await runAgentPrint(agent, prompt, root, {
        timeoutMs,
        allowEdits: false,
        rejectOnError: true,
      });
      return out.output || '';
    };

    try {
      const result = await runTailor({
        company,
        role,
        url,
        jd,
        workspace: ws,
        runAgent,
      });
      return {
        success: true,
        slug: result.slug,
        dir: result.dir,
        paths: result.paths,
        agent,
        // Send a small preview the frontend can render in the modal.
        // Capped so a huge CV doesn't blow up the response.
        preview: {
          cv_excerpt: result.payload.tailored_cv_markdown.slice(0, 1200),
          cover_letter_excerpt: result.payload.cover_letter_markdown.slice(0, 1200),
          qa_count: result.payload.qa_pairs.length,
          qa_first: result.payload.qa_pairs.slice(0, 2),
        },
      };
    } catch (err) {
      return reply.code(502).send({ error: err.message || String(err) });
    }
  });

  app.get('/tailor/file', async (req, reply) => {
    const rel = String(req.query?.path || '').trim();
    if (!rel.startsWith('output/tailor-bundles/')) {
      return reply.code(400).send({ error: 'path must be under output/tailor-bundles/' });
    }
    const ws = asWorkspace(root);
    const content = ws.read(rel);
    if (content == null) return reply.code(404).send({ error: 'file not found' });
    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    return content;
  });
}
