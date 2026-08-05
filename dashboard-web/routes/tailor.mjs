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
import { readProfile } from '../lib/writers.mjs';
import { createTailorCoordinator } from '../lib/tailor-coordinator.mjs';
import { asWorkspace } from '../../lib/workspace.mjs';
import { basename, extname } from 'path';
import { launchChromiumWithRetry } from '../../lib/playwright-launch.mjs';

async function generatePdfFromHtml(ws, htmlRelPath, pdfRelPath) {
  const html = ws.read(htmlRelPath);
  if (html == null) throw new Error(`Missing HTML source for PDF: ${htmlRelPath}`);
  const browser = await launchChromiumWithRetry(
    { headless: true },
    { onWarn: (msg) => console.warn(`Tailor PDF warning: ${msg}`) },
  );
  try {
    const page = await browser.newPage();
    await page.setContent(html, {
      waitUntil: 'networkidle',
      baseURL: `file://${ws.resolve(htmlRelPath).replace(/\/[^/]+$/, '')}/`,
    });
    await page.evaluate(() => document.fonts?.ready || true);
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: { top: '0.6in', right: '0.6in', bottom: '0.6in', left: '0.6in' },
    });
    ws.write(pdfRelPath, pdf);
  } finally {
    await browser.close();
  }
}

async function generateTailorPdfs(ws, paths = {}) {
  if (paths.cvHtml && paths.cvPdf) await generatePdfFromHtml(ws, paths.cvHtml, paths.cvPdf);
  if (paths.coverLetterHtml && paths.coverLetterPdf) await generatePdfFromHtml(ws, paths.coverLetterHtml, paths.coverLetterPdf);
}

export default async function (app) {
  const root = app.cataBullRoot;
  const coordinator = createTailorCoordinator({ root, generatePdfs: generateTailorPdfs });

  app.post('/tailor', async (req, reply) => {
    const { company, role, url, jd, force } = req.body || {};
    if (!company || !role) {
      return reply.code(400).send({ error: 'company and role are required' });
    }

    const profile = readProfile(root) || {};
    const agent = profile?.preferences?.agent || req.body?.agent;

    // Tailor wires together CV + cover letter + Q&A in one agent call.
    // It's expensive (full CV + JD context) but onboarding-style — runs
    // on demand, not on every page load. 6-minute ceiling.
    const timeoutMs = 360_000;
    reply.raw.setTimeout?.(timeoutMs + 30_000, () => {});

    const runAgent = async (prompt) => {
      if (!agent) {
        const error = new Error('No agent configured');
        error.statusCode = 400;
        throw error;
      }
      const out = await runAgentPrint(agent, prompt, root, {
        timeoutMs,
        allowEdits: true,
        rejectOnError: true,
      });
      return out.output || '';
    };

    try {
      const result = await coordinator.tailor({
        company,
        role,
        url,
        jd,
        force: force === true,
      }, { runAgent });
      return {
        ...result,
        agent,
      };
    } catch (err) {
      return reply.code(err.statusCode || 502).send({ error: err.message || String(err) });
    }
  });

  app.get('/tailor/file', async (req, reply) => {
    const rel = String(req.query?.path || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel.startsWith('output/tailor-bundles/')) {
      return reply.code(400).send({ error: 'path must be under output/tailor-bundles/' });
    }
    if (rel.includes('..')) return reply.code(400).send({ error: 'invalid path' });
    const ws = asWorkspace(root);
    const content = ws.read(rel);
    if (content == null) return reply.code(404).send({ error: 'file not found' });
    const ext = extname(rel).slice(1).toLowerCase();
    const mime = ext === 'pdf' ? 'application/pdf'
      : ext === 'html' ? 'text/html; charset=utf-8'
      : ext === 'doc' ? 'application/msword'
      : 'text/markdown; charset=utf-8';
    reply
      .header('Content-Type', mime)
      .header('Content-Disposition', `attachment; filename="${basename(rel)}"`);
    return content;
  });
}
