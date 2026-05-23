/**
 * backup.mjs — Export and import the user-data layer as a zip.
 *
 * Lets a user move profile + history between branches/machines without
 * fighting gitignore. Bundles the User Layer files defined in CLAUDE.md /
 * DATA_CONTRACT.md (cv.md, config/profile.yml, modes/_profile.md,
 * portals.yml, data/*, reports/*, output/*, interview-prep/*) plus the
 * ephemeral memory dir. Skips system files, node_modules, .git, etc.
 *
 * Endpoints:
 *   GET  /backup           Download a catabull-backup-{date}.zip
 *   POST /backup/restore   Multipart upload of a zip; extracts in-place
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, relative, resolve, sep } from 'path';
import JSZip from 'jszip';

// User Layer paths to include. Files (single) and dirs (recursive) listed
// separately so the include is explicit — no surprises from auto-globbing.
const USER_LAYER_FILES = [
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'portals.yml',
  'article-digest.md',
];

const USER_LAYER_DIRS = [
  'data',           // applications.md, pipeline.md, scan-history.tsv, outreach/
  'reports',
  'output',         // generated CVs/PDFs
  'interview-prep',
  'memory',         // pattern-learning entries written by the agent
];

// Hard skip list inside USER_LAYER_DIRS — we don't want to ship logs or
// transient agent state.
const SKIP_PATTERNS = [
  /^output\/(opencode|codex|claude)-/i,            // agent xdg dirs
  /^output\/dashboard-.*\.log$/i,                   // dashboard logs
  /\.log$/i,                                         // any log file
  /\/\.DS_Store$/i,
];

function shouldSkip(rel) {
  return SKIP_PATTERNS.some(re => re.test(rel));
}

function walkDir(root, dirRel, onFile) {
  const abs = join(root, dirRel);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    const childRel = `${dirRel}/${name}`;
    const childAbs = join(abs, name);
    const st = statSync(childAbs);
    if (st.isDirectory()) {
      walkDir(root, childRel, onFile);
    } else if (st.isFile()) {
      if (shouldSkip(childRel)) continue;
      onFile(childRel, childAbs);
    }
  }
}

// Resolve a zip-entry path against the project root, refusing zip-slip.
function safeResolve(root, rel) {
  if (!rel || rel.includes('..')) return null;
  const abs = resolve(root, rel);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  return abs;
}

// Filter incoming entries to the same User Layer scope. Anything outside
// that scope is ignored — a malicious or careless zip can't overwrite
// system files (CLAUDE.md, scripts, etc).
function isInUserLayer(rel) {
  if (USER_LAYER_FILES.includes(rel)) return true;
  return USER_LAYER_DIRS.some(dir => rel === dir || rel.startsWith(dir + '/'));
}

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/backup', async (req, reply) => {
    const zip = new JSZip();

    for (const file of USER_LAYER_FILES) {
      const abs = join(root, file);
      if (!existsSync(abs)) continue;
      zip.file(file, readFileSync(abs));
    }

    for (const dir of USER_LAYER_DIRS) {
      walkDir(root, dir, (rel, abs) => {
        zip.file(rel, readFileSync(abs));
      });
    }

    // Embed a small manifest so the importer can sanity-check what it's
    // looking at (and so a future format bump is detectable).
    zip.file('.catabull-backup.json', JSON.stringify({
      version: 1,
      created_at: new Date().toISOString(),
      app: 'catabull',
    }, null, 2));

    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const date = new Date().toISOString().slice(0, 10);
    const filename = `catabull-backup-${date}.zip`;
    return reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(buffer);
  });

  app.post('/backup/restore', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });

    const buffer = await file.toBuffer();
    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      return reply.code(400).send({ error: 'Invalid zip file' });
    }

    // Sanity-check the manifest if present. Missing manifest is allowed —
    // someone may zip up these files manually — but mismatched app rejects.
    const manifestEntry = zip.file('.catabull-backup.json');
    if (manifestEntry) {
      try {
        const manifest = JSON.parse(await manifestEntry.async('string'));
        if (manifest.app && manifest.app !== 'catabull') {
          return reply.code(400).send({ error: `Backup is from "${manifest.app}", not catabull` });
        }
      } catch { /* corrupt manifest — keep going if user accepts */ }
    }

    const written = [];
    const skipped = [];

    for (const [rel, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (rel === '.catabull-backup.json') continue;
      if (!isInUserLayer(rel)) {
        skipped.push({ path: rel, reason: 'outside user layer' });
        continue;
      }
      const abs = safeResolve(root, rel);
      if (!abs) {
        skipped.push({ path: rel, reason: 'unsafe path' });
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, await entry.async('nodebuffer'));
      written.push(rel);
    }

    return { success: true, written: written.length, skipped: skipped.length, skippedDetail: skipped };
  });
}
