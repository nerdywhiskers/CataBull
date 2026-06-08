import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, renameSync } from 'fs';
import { join, extname, basename } from 'path';
import JSZip from 'jszip';
import { loadReportSummary, parseApplications } from '../lib/parsers.mjs';

function reportArchiveDir(root) {
  return join(root, 'reports', 'archive');
}

export function resolveReportPath(root, filename) {
  const activePath = join(root, 'reports', filename);
  if (existsSync(activePath)) return { path: activePath, archived: false };
  const archivedPath = join(reportArchiveDir(root), filename);
  if (existsSync(archivedPath)) return { path: archivedPath, archived: true };
  return null;
}

export function archiveReportFile(root, filename) {
  const activePath = join(root, 'reports', filename);
  if (!existsSync(activePath)) return null;
  const archiveDir = reportArchiveDir(root);
  mkdirSync(archiveDir, { recursive: true });
  const archivedPath = join(archiveDir, filename);
  renameSync(activePath, archivedPath);
  return { path: archivedPath, archived: true };
}

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

function workspacePath(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return null;
  return join(root, ...clean.split('/'));
}

export function collectReportExportEntries(root, filename, { resolved = null, artifacts = [], tailorBundle = null } = {}) {
  const reportResolved = resolved || resolveReportPath(root, filename);
  if (!reportResolved) return [];
  const entries = [{
    zipPath: `report/${filename}`,
    absPath: reportResolved.path,
  }];

  for (const artifact of artifacts || []) {
    const absPath = workspacePath(root, artifact.path);
    if (!absPath || !existsSync(absPath)) continue;
    entries.push({
      zipPath: `artifacts/${basename(absPath)}`,
      absPath,
    });
  }

  for (const relPath of Object.values(tailorBundle?.paths || {})) {
    const absPath = workspacePath(root, relPath);
    if (!absPath || !existsSync(absPath)) continue;
    entries.push({
      zipPath: `tailor-bundle/${basename(absPath)}`,
      absPath,
    });
  }

  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.zipPath}|${entry.absPath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function buildReportExportZip(root, filename, options = {}) {
  const entries = collectReportExportEntries(root, filename, options);
  if (!entries.length) return null;
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.zipPath, readFileSync(entry.absPath));
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, entries };
}

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/reports', async () => {
    const dir = join(root, 'reports');
    if (!existsSync(dir)) return { reports: [], archivedCount: 0 };

    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md') && f !== '.gitkeep')
      .sort()
      .reverse();
    const archiveDir = reportArchiveDir(root);
    const archivedCount = existsSync(archiveDir)
      ? readdirSync(archiveDir).filter(f => f.endsWith('.md') && f !== '.gitkeep').length
      : 0;
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
        archived: false,
        ...summary,
      };
    });

    return { reports, archivedCount };
  });

  app.get('/reports/:filename', async (req, reply) => {
    const { filename } = req.params;
    // Sanitize filename
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }
    const resolved = resolveReportPath(root, filename);
    if (!resolved) return reply.code(404).send({ error: 'Report not found' });

    const raw = readFileSync(resolved.path, 'utf-8');
    const artifacts = findArtifactsForReport(root, filename);
    const reportApp = parseApplications(root).find((app) => app.reportPath === `reports/${filename}`);
    return { raw, filename, artifacts, tailorBundle: reportApp?.tailorBundle || null, archived: resolved.archived };
  });

  app.get('/reports/:filename/export.zip', async (req, reply) => {
    const { filename } = req.params;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }
    const resolved = resolveReportPath(root, filename);
    if (!resolved) return reply.code(404).send({ error: 'Report not found' });
    const artifacts = findArtifactsForReport(root, filename);
    const reportApp = parseApplications(root).find((app) => app.reportPath === `reports/${filename}`);
    const zip = await buildReportExportZip(root, filename, {
      resolved,
      artifacts,
      tailorBundle: reportApp?.tailorBundle || null,
    });
    if (!zip) return reply.code(404).send({ error: 'Nothing to export' });
    const downloadName = filename.replace(/\.md$/i, '') + '-bundle.zip';
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${downloadName}"`)
      .send(zip.buffer);
  });

  app.post('/reports/:filename/archive', async (req, reply) => {
    const { filename } = req.params;
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }
    const archived = archiveReportFile(root, filename);
    if (!archived) return reply.code(404).send({ error: 'Report not found' });
    return { ok: true, filename, archived: true };
  });
}
