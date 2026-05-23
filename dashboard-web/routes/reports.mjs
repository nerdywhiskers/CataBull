import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { loadReportSummary } from '../lib/parsers.mjs';

// Find files in output/ that look like they belong to this report. We match
// by company slug (the middle segment of the report filename), looking for
// any cv-*{slug}* or {slug}-* artifact in {md,html,pdf}. PDFs and HTML
// versions of a generated CV both qualify, plus any markdown variant.
function findArtifactsForReport(root, reportFilename) {
  const match = reportFilename.match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  if (!match) return [];
  const slug = match[1].toLowerCase();
  const outputDir = join(root, 'output');
  if (!existsSync(outputDir)) return [];

  // Match the slug as a token: surrounded by `-` or end-of-name boundaries,
  // so "openai" doesn't accidentally match "openaire".
  const slugRe = new RegExp(`(^|-)${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-|\\.)`, 'i');

  const artifacts = [];
  for (const file of readdirSync(outputDir)) {
    const ext = extname(file).slice(1).toLowerCase();
    if (!['md', 'html', 'pdf'].includes(ext)) continue;
    // Restrict to cv-* artifacts so we don't accidentally surface log files
    // or unrelated saves. The /cv/download endpoint also accepts only this
    // prefix, so the link won't 400.
    if (!file.toLowerCase().startsWith('cv-')) continue;
    if (!slugRe.test(file)) continue;
    const abs = join(outputDir, file);
    artifacts.push({
      name: file,
      path: `output/${file}`,
      format: ext,
      modified: statSync(abs).mtimeMs,
      size: statSync(abs).size,
    });
  }
  artifacts.sort((a, b) => b.modified - a.modified);
  return artifacts;
}

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/reports', async () => {
    const dir = join(root, 'reports');
    if (!existsSync(dir)) return { reports: [] };

    const files = readdirSync(dir).filter(f => f.endsWith('.md') && f !== '.gitkeep').sort().reverse();
    const reports = files.map(f => {
      const path = `reports/${f}`;
      const summary = loadReportSummary(root, path);
      // Parse filename: ###-company-slug-YYYY-MM-DD.md
      const match = f.match(/^(\d+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/);
      return {
        filename: f,
        path,
        number: match ? match[1] : '',
        slug: match ? match[2] : f,
        date: match ? match[3] : '',
        ...summary,
      };
    });

    return { reports };
  });

  app.get('/reports/:filename', async (req, reply) => {
    const { filename } = req.params;
    // Sanitize filename
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }
    const path = join(root, 'reports', filename);
    if (!existsSync(path)) return reply.code(404).send({ error: 'Report not found' });

    const raw = readFileSync(path, 'utf-8');
    const artifacts = findArtifactsForReport(root, filename);
    return { raw, filename, artifacts };
  });
}
