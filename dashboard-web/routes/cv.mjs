import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, extname, resolve, sep } from 'path';
import { readCV, writeCV } from '../lib/writers.mjs';

const FLAT_OUTPUT_CV_RE = /^output\/cv-[^/]+\.(md|html|pdf)$/i;
const TAILOR_BUNDLE_CV_RE = /^output\/tailor-bundles\/[^/]+\/(?:tailored-)?cv\.(md|pdf)$/i;
const FORMAT_ORDER = ['md', 'pdf', 'html'];

// Resolve a user-supplied CV path against the project root, refusing anything
// that escapes the project tree or points outside the allowed locations.
// Allowed: cv.md, output/cv-*.{md,html,pdf}, and generated tailor bundle CVs.
export function resolveCvPath(root, requested) {
  if (!requested) return { ok: false, error: 'path is required' };
  const cleaned = String(requested).replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.includes('..')) return { ok: false, error: 'invalid path' };

  const abs = resolve(root, cleaned);
  const rootAbs = resolve(root);
  if (!abs.startsWith(rootAbs + sep) && abs !== rootAbs) return { ok: false, error: 'path escapes project root' };

  const rel = abs.slice(rootAbs.length + 1).split(sep).join('/');
  const isMaster = rel === 'cv.md';
  const isOutputCv = FLAT_OUTPUT_CV_RE.test(rel);
  const isTailorBundleCv = TAILOR_BUNDLE_CV_RE.test(rel);
  if (!isMaster && !isOutputCv && !isTailorBundleCv) {
    return { ok: false, error: 'CV path must be cv.md, output/cv-*.{md,html,pdf}, or a CV under output/tailor-bundles/*/' };
  }

  return { ok: true, abs, rel, isMaster };
}

function relAbs(root, rel) {
  return join(root, ...String(rel).split('/'));
}

function addExistingVariant(root, variants, format, rel) {
  if (existsSync(relAbs(root, rel))) variants[format] = rel;
}

function buildCvItem(root, { name, path, master = false, source = 'output', variants = {} }) {
  const abs = relAbs(root, path);
  const format = extname(path).slice(1).toLowerCase();
  const formats = FORMAT_ORDER.filter((fmt) => variants[fmt]);
  const item = {
    name,
    path,
    format,
    formats: formats.length ? formats : [format],
    master,
    source,
    modified: statSync(abs).mtimeMs,
  };
  if (variants.md) item.downloadMdPath = variants.md;
  if (variants.pdf) item.downloadPdfPath = variants.pdf;
  if (variants.html) item.downloadHtmlPath = variants.html;
  return item;
}

function listFlatOutputCvs(root) {
  const outputDir = join(root, 'output');
  if (!existsSync(outputDir)) return [];

  const groups = new Map();
  for (const file of readdirSync(outputDir)) {
    const abs = join(outputDir, file);
    if (!statSync(abs).isFile()) continue;
    const rel = `output/${file}`;
    if (!FLAT_OUTPUT_CV_RE.test(rel)) continue;

    const format = extname(file).slice(1).toLowerCase();
    const baseRel = rel.replace(/\.(md|html|pdf)$/i, '');
    const group = groups.get(baseRel) || { variants: {}, modified: 0 };
    group.variants[format] = rel;
    group.modified = Math.max(group.modified, statSync(abs).mtimeMs);
    groups.set(baseRel, group);
  }

  return [...groups.entries()].map(([baseRel, group]) => {
    const path = group.variants.md || group.variants.pdf || group.variants.html;
    const item = buildCvItem(root, {
      name: basename(baseRel),
      path,
      variants: group.variants,
    });
    item.modified = group.modified;
    return item;
  });
}

function listTailorBundleCvs(root) {
  const bundleRoot = join(root, 'output', 'tailor-bundles');
  if (!existsSync(bundleRoot)) return [];

  const items = [];
  for (const entry of readdirSync(bundleRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const baseRel = `output/tailor-bundles/${entry.name}`;
    const variants = {};
    addExistingVariant(root, variants, 'md', `${baseRel}/cv.md`);
    if (!variants.md) addExistingVariant(root, variants, 'md', `${baseRel}/tailored-cv.md`);
    addExistingVariant(root, variants, 'pdf', `${baseRel}/cv.pdf`);
    const path = variants.md || variants.pdf;
    if (!path) continue;

    items.push(buildCvItem(root, {
      name: `${entry.name} (tailor bundle)`,
      path,
      source: 'tailor-bundle',
      variants,
    }));
  }
  return items;
}

export function listCvFiles(root) {
  const cvs = [];
  const masterAbs = join(root, 'cv.md');
  if (existsSync(masterAbs)) {
    cvs.push(buildCvItem(root, {
      name: 'cv.md (master)',
      path: 'cv.md',
      master: true,
      source: 'master',
      variants: { md: 'cv.md' },
    }));
  }
  cvs.push(...listFlatOutputCvs(root), ...listTailorBundleCvs(root));
  cvs.sort((a, b) => (b.master ? 1 : 0) - (a.master ? 1 : 0) || b.modified - a.modified || a.name.localeCompare(b.name));
  return cvs;
}

export default async function (app) {
  const root = app.cataBullRoot;

  // List the master CV and any tailored variants saved under output/.
  app.get('/cv/list', async () => {
    return { cvs: listCvFiles(root) };
  });

  // Get CV content. Defaults to the master cv.md when no path is supplied,
  // for backwards compatibility with the original single-CV endpoint.
  app.get('/cv', async (req, reply) => {
    const requested = req.query?.path;
    if (!requested) return { raw: readCV(root), path: 'cv.md', format: 'md' };

    const resolved = resolveCvPath(root, requested);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    if (!existsSync(resolved.abs)) return reply.code(404).send({ error: 'CV not found' });

    const format = extname(resolved.abs).slice(1).toLowerCase();
    // html/pdf are surfaced via the download endpoint; the editor only
    // handles markdown.
    if (format !== 'md') return { raw: '', path: resolved.rel, format, binary: true };
    return { raw: readFileSync(resolved.abs, 'utf-8'), path: resolved.rel, format };
  });

  app.put('/cv', async (req, reply) => {
    const { path: requested, content } = req.body || {};
    if (!requested || requested === 'cv.md') {
      writeCV(root, content);
      return { success: true, path: 'cv.md' };
    }
    const resolved = resolveCvPath(root, requested);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    if (extname(resolved.abs).toLowerCase() !== '.md') {
      return reply.code(400).send({ error: 'Only .md CVs are editable here' });
    }
    writeFileSync(resolved.abs, content);
    return { success: true, path: resolved.rel };
  });

  // Download a CV file directly. Used by the dashboard's Download button so
  // the user can save the master cv.md or a tailored output/cv-*.{md,html,pdf}
  // without copy-pasting.
  app.get('/cv/download', async (req, reply) => {
    const resolved = resolveCvPath(root, req.query?.path);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });
    if (!existsSync(resolved.abs)) return reply.code(404).send({ error: 'CV not found' });

    const filename = basename(resolved.abs);
    const ext = extname(filename).slice(1).toLowerCase();
    const mime = ext === 'pdf' ? 'application/pdf'
      : ext === 'html' ? 'text/html'
      : 'text/markdown';
    reply
      .header('Content-Type', mime)
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(readFileSync(resolved.abs));
  });
}
