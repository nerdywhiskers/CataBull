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
import { appendTailorReportSection, runTailor, writeTailorReport } from '../../lib/tailor.mjs';
import { readProfile, markPipelineTailored } from '../lib/writers.mjs';
import { parseApplications } from '../lib/parsers.mjs';
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

function findExistingReport(root, { company, role, url } = {}) {
  const companyKey = String(company || '').trim().toLowerCase();
  const roleKey = String(role || '').trim().toLowerCase();
  const urlKey = String(url || '').trim();
  return parseApplications(root).find((app) => (
    app.reportPath
    && (
      (urlKey && app.jobUrl === urlKey)
      || (
        String(app.company || '').trim().toLowerCase() === companyKey
        && String(app.role || '').trim().toLowerCase() === roleKey
      )
    )
  ));
}

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
      await generateTailorPdfs(ws, result.paths);
      const existingReport = findExistingReport(root, { company, role, url });
      const appended = existingReport?.reportPath
        ? appendTailorReportSection(ws, existingReport.reportPath, result)
        : null;
      const report = appended
        ? { ...appended, filename: existingReport.reportPath.split('/').pop(), existing: true }
        : writeTailorReport(ws, result, { company, role, url });
      markPipelineTailored(root, {
        url,
        company,
        role,
        reportPath: report.path,
        reportNumber: report.number || existingReport?.reportNumber || '',
        hasPdf: Boolean(result.paths?.cvPdf),
      });
      return {
        success: true,
        slug: result.slug,
        dir: result.dir,
        paths: result.paths,
        report,
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
      : 'text/markdown; charset=utf-8';
    reply
      .header('Content-Type', mime)
      .header('Content-Disposition', `attachment; filename="${basename(rel)}"`);
    return content;
  });
}
