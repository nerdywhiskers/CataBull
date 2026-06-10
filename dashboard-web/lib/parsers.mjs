import { asWorkspace } from '../../lib/workspace.mjs';
import { tailorSlug } from '../../lib/tailor.mjs';
import { applicationsPath } from './writers.mjs';

// --- Regex patterns (ported from dashboard/internal/data/career.go) ---
const RE_REPORT_LINK = /\[(\d+)\]\(([^)]+)\)/;
const RE_SCORE_VALUE = /(\d+\.?\d*)\/5/;
const RE_ARCHETYPE = /\*\*(?:Archetype|Arquetipo)(?:\s+detectado)?\*\*\s*\|\s*(.+)/i;
const RE_ARCHETYPE_COLON = /\*\*(?:Archetype|Arquetipo):\*\*\s*(.+)/i;
const RE_TLDR = /\*\*TL;DR\*\*\s*\|\s*(.+)/i;
const RE_TLDR_COLON = /\*\*TL;DR:\*\*\s*(.+)/i;
const RE_REMOTE = /\*\*Remote\*\*\s*\|\s*(.+)/i;
const RE_COMP = /\*\*Comp\*\*\s*\|\s*(.+)/i;
const RE_REPORT_URL = /^\*\*URL:\*\*\s*(https?:\/\/\S+)/m;
const RE_BATCH_ID = /^\*\*Batch ID:\*\*\s*(\d+)/m;

// --- Per-block score parsing (issue #28) ---
//
// Pinned weights (matches modes/_shared.md). Surfaced in the dashboard
// alongside the parsed sub-scores so the user can see how the global
// score was derived.
export const SCORE_WEIGHTS = {
  A: { label: 'Match con CV', weight: 0.30 },
  B: { label: 'North Star', weight: 0.25 },
  C: { label: 'Comp', weight: 0.20 },
  D: { label: 'Cultural', weight: 0.15 },
  E: { label: 'Red flags', weight: 0.10, isPenalty: true },
};

// Mandated breakdown line in new reports:
//   Score: 4.0/5 — A:4.5 · B:5.0 · C:3.5 · D:4.0 · E:4.5
// Accepts any non-letter separators between pairs (space, ·, |, comma).
const RE_SCORE_BREAKDOWN = /\b([A-E])\s*:\s*(\d+\.?\d*)/gi;
// Loose fallback: lines like "**A — Match con CV:** 4.5/5" or "## C: 3.5"
const RE_BLOCK_LOOSE = /(?:^|[\s|*#`>])([A-E])\b[^\d]{0,40}?(\d+\.?\d*)\s*\/\s*5\b/gm;

/**
 * Extract per-block scores (A-E) from a report's markdown body. Tries
 * the structured `Score: X/5 — A:N · B:N · ...` line first (mandated
 * by modes/_shared.md), falls back to loose per-line patterns for
 * legacy reports.
 *
 * Returns an object mapping block letter → numeric score, e.g.
 * `{ A: 4.5, B: 5.0, C: 3.5, D: 4.0, E: 4.5 }`. Returns null if no
 * blocks could be parsed (so callers can hide the breakdown UI cleanly).
 *
 * Exported for testing.
 */
export function parseBlockScores(reportText) {
  if (!reportText) return null;

  // Tier 1: structured line. Bound to the line that contains the global
  // score so we don't accidentally parse "URL: x.com/A:4" elsewhere.
  // Tolerates inline markdown bolding both before/after the colon
  // (`**Score:** 4.2/5` or `Score: **4.2**/5`) — matches anything between
  // "Score" and the eventual "<digits>/5".
  const scoreLine = String(reportText).match(/^.*\bScore\b[^\n]*?\d+\.?\d*\s*\/\s*5.*$/m);
  if (scoreLine) {
    const out = {};
    RE_SCORE_BREAKDOWN.lastIndex = 0;
    let m;
    while ((m = RE_SCORE_BREAKDOWN.exec(scoreLine[0])) !== null) {
      const letter = m[1].toUpperCase();
      const value = parseFloat(m[2]);
      if (Number.isFinite(value) && value >= 0 && value <= 5) out[letter] = value;
    }
    if (Object.keys(out).length >= 4) return out;
  }

  // Tier 2: loose. Scans the whole document for "A ... 4.5/5"-style hits
  // and takes the first occurrence per letter (block headers usually
  // appear at the top of each block's discussion).
  const out = {};
  RE_BLOCK_LOOSE.lastIndex = 0;
  let m;
  while ((m = RE_BLOCK_LOOSE.exec(reportText)) !== null) {
    const letter = m[1].toUpperCase();
    const value = parseFloat(m[2]);
    if (!Number.isFinite(value)) continue;
    if (out[letter] === undefined) out[letter] = value;
  }

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extract a short "why this score" excerpt from a report — the first
 * non-empty paragraph after the `Score: X/5` line, capped to ~280 chars
 * so it fits in a tooltip/modal without scrolling. Skips structural
 * markdown (headings, table separators, the breakdown line itself).
 *
 * Used by the score-rationale modal so we can show *why* a score is what
 * it is without making the client fetch + render the whole report.
 *
 * Exported for testing.
 */
export function extractRationaleExcerpt(reportText, maxChars = 280) {
  if (!reportText) return '';
  const lines = String(reportText).split('\n');
  let scoreIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    // Tolerate `**Score:**` markdown bolding the same way parseBlockScores does.
    if (/\bScore\b[^\n]*?\d+\.?\d*\s*\/\s*5/.test(lines[i])) { scoreIdx = i; break; }
  }
  if (scoreIdx === -1) return '';

  const collected = [];
  for (let i = scoreIdx + 1; i < lines.length && collected.length < 4; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) { if (collected.length) break; else continue; }
    // Skip headings, table separators, blockquotes that are just the
    // breakdown line.
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^\|[-:|\s]+\|?$/.test(trimmed)) continue;
    if (/^[A-E]\s*:\s*\d/.test(trimmed)) continue;
    collected.push(trimmed);
  }

  let text = collected.join(' ').replace(/\s+/g, ' ').trim();
  // Strip leading markdown decoration ("**TL;DR:**", "> ", etc.)
  text = text.replace(/^[>*\s]+/, '').replace(/^\*\*[^*]+\*\*\s*[:|]?\s*/, '');
  if (text.length > maxChars) text = text.substring(0, maxChars - 1).trimEnd() + '…';
  return text;
}

/**
 * Compute the global score from per-block scores using the pinned
 * weights. Mirrors the formula in modes/_shared.md. Returns null when
 * any of A-D is missing — we don't want to display a global-score
 * derivation that's missing inputs.
 *
 * Exported for testing.
 */
export function computeWeightedScore(blocks) {
  if (!blocks) return null;
  const a = blocks.A, b = blocks.B, c = blocks.C, d = blocks.D, e = blocks.E;
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) return null;
  const weighted = a * 0.30 + b * 0.25 + c * 0.20 + d * 0.15;
  const penalty = Number.isFinite(e) ? (5 - e) * 0.10 : 0;
  return Math.round((weighted - penalty) * 10) / 10; // 1 decimal place
}

function cleanTableCell(s) {
  return s.trim().replace(/\|+$/, '').trim();
}

/** Normalize status to canonical form (ported from Go NormalizeStatus). */
export function normalizeStatus(raw) {
  let s = raw.replace(/\*\*/g, '').trim().toLowerCase();
  // Strip trailing date
  const dateIdx = s.indexOf(' 202');
  if (dateIdx > 0) s = s.substring(0, dateIdx).trim();

  if (s.includes('no aplicar') || s.includes('no_aplicar') || s === 'skip' || s.includes('geo blocker')) return 'skip';
  if (s.includes('interview') || s.includes('entrevista')) return 'interview';
  if (s === 'offer' || s.includes('oferta')) return 'offer';
  if (s.includes('responded') || s.includes('respondido')) return 'responded';
  if (s.includes('applied') || s.includes('aplicado') || s === 'enviada' || s === 'aplicada' || s === 'sent') return 'applied';
  if (s.includes('rejected') || s.includes('rechazado') || s === 'rechazada') return 'rejected';
  if (s.includes('discarded') || s.includes('descartado') || s === 'descartada' || s === 'cerrada' || s === 'cancelada' || s.startsWith('duplicado') || s.startsWith('dup')) return 'discarded';
  if (s.includes('evaluated') || s.includes('evaluada') || s === 'condicional' || s === 'hold' || s === 'monitor' || s === 'evaluar' || s === 'verificar') return 'evaluated';
  return s;
}

export function statusPriority(status) {
  const priorities = { interview: 0, offer: 1, responded: 2, applied: 3, evaluated: 4, skip: 5, rejected: 6, discarded: 7 };
  return priorities[normalizeStatus(status)] ?? 8;
}

/** Parse applications.md and return array of application objects. */
export function parseApplications(cataBullRoot) {
  const ws = asWorkspace(cataBullRoot);
  const relPath = ws.exists('data/applications.md') ? 'data/applications.md' : 'applications.md';
  const content = ws.read(relPath);
  if (content == null) return [];

  const lines = content.split('\n');
  const apps = [];
  let num = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('# ') || line.startsWith('|---') || line.startsWith('| #') || !line.startsWith('|')) continue;

    let fields;
    if (line.includes('\t')) {
      fields = line.replace(/^\|/, '').trim().split('\t').map(f => f.replace(/\|/g, '').trim());
    } else {
      fields = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(f => f.trim());
    }

    if (fields.length < 8) continue;
    num++;

    const app = {
      num,
      date: fields[1],
      company: fields[2],
      role: fields[3],
      scoreRaw: fields[4],
      score: 0,
      status: fields[5],
      statusNormalized: normalizeStatus(fields[5]),
      hasPdf: fields[6].includes('\u2705'),
      reportPath: '',
      reportNumber: '',
      tailorBundle: null,
      notes: fields.length > 8 ? fields[8] : '',
      jobUrl: '',
      enrichment: null,
    };

    const sm = fields[4].match(RE_SCORE_VALUE);
    if (sm) app.score = parseFloat(sm[1]);

    const rm = fields[7].match(RE_REPORT_LINK);
    if (rm) {
      app.reportNumber = rm[1];
      app.reportPath = rm[2];
    }

    apps.push(app);
  }

  // Enrich with job URLs (simplified: tiers 1 + 4)
  enrichFromReports(cataBullRoot, apps);
  enrichFromScanHistory(cataBullRoot, apps);
  enrichTailorBundles(cataBullRoot, apps);

  return apps;
}

function enrichTailorBundles(root, apps) {
  const ws = asWorkspace(root);
  for (const app of apps) {
    const date = String(app.date || '').trim();
    if (!date) continue;
    const slug = tailorSlug(app.company, app.role, { date });
    const dir = `output/tailor-bundles/${slug}`;
    const paths = {
      cv: `${dir}/cv.md`,
      coverLetter: `${dir}/cover-letter.md`,
      qa: `${dir}/answers.md`,
      cvHtml: `${dir}/cv.html`,
      coverLetterHtml: `${dir}/cover-letter.html`,
      cvPdf: `${dir}/cv.pdf`,
      coverLetterPdf: `${dir}/cover-letter.pdf`,
    };
    const existingPaths = Object.fromEntries(
      Object.entries(paths).filter(([, relPath]) => ws.exists(relPath))
    );
    if (Object.keys(existingPaths).length === 0) continue;
    app.tailorBundle = { slug, dir, paths: existingPaths };
  }
}

function enrichFromReports(root, apps) {
  const ws = asWorkspace(root);
  for (const app of apps) {
    if (!app.reportPath) continue;
    try {
      const full = ws.read(app.reportPath);
      if (full == null) continue;
      const header = full.substring(0, 1000);
      const m = header.match(RE_REPORT_URL);
      if (m) app.jobUrl = m[1];

      // Per-block scores (issue #28). Parse the whole report body since
      // the breakdown line may live under the score header or anywhere
      // in the first ~2k chars depending on the report style.
      const headBody = full.substring(0, 4000);
      const blocks = parseBlockScores(headBody);
      if (blocks) {
        app.scoreBlocks = blocks;
        const computed = computeWeightedScore(blocks);
        if (computed != null) app.scoreComputed = computed;
      }
      // Short "why this score" excerpt for the rationale modal. Pulled
      // from the same head body so the cost is one read per app, not two.
      const excerpt = extractRationaleExcerpt(headBody);
      if (excerpt) app.rationaleExcerpt = excerpt;
    } catch { /* skip */ }
  }
}

function enrichFromScanHistory(root, apps) {
  const content = asWorkspace(root).read('data/scan-history.tsv');
  if (content == null) return;

  const byCompany = {};
  for (const line of content.split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 5 || fields[0] === 'url' || !fields[0].startsWith('http')) continue;
    const key = normalizeCompany(fields[4]);
    if (!byCompany[key]) byCompany[key] = [];
    byCompany[key].push({ url: fields[0], title: fields[3] });
  }

  for (const app of apps) {
    if (app.jobUrl) continue;
    const key = normalizeCompany(app.company);
    const matches = byCompany[key];
    if (!matches) continue;
    if (matches.length === 1) { app.jobUrl = matches[0].url; continue; }
    // Pick best role match
    const appRole = app.role.toLowerCase();
    let best = matches[0].url, bestScore = 0;
    for (const m of matches) {
      let score = 0;
      const mTitle = m.title.toLowerCase();
      for (const word of appRole.split(/\s+/)) {
        if (word.length > 2 && mTitle.includes(word)) score++;
      }
      if (score > bestScore) { bestScore = score; best = m.url; }
    }
    app.jobUrl = best;
  }
}

function normalizeCompany(name) {
  let s = name.trim().toLowerCase();
  for (const suffix of [' inc.', ' inc', ' llc', ' ltd', ' corp', ' corporation', ' technologies', ' technology', ' group', ' co.']) {
    if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  }
  return s.trim();
}

/** Parse pipeline.md and return pending, skipped, and expired offers. */
export function parsePipeline(cataBullRoot) {
  const content = asWorkspace(cataBullRoot).read('data/pipeline.md');
  if (content == null) return { pending: [], skipped: [], expired: [] };

  const pending = [];
  const skipped = [];
  const expired = [];
  let inProcessed = false;

  for (const line of content.split('\n')) {
    if (/^##\s+Procesad/i.test(line)) { inProcessed = true; continue; }
    if (inProcessed) continue;

    // Match pipeline lines with optional status, action date, and posted date
    // - [ ] URL | Company | Role | posted:2026-04-01
    // - [x] URL | Company | Role | SKIP | 2026-04-19
    // - [x] URL | Company | Role | posted:2026-04-01 | EXPIRED | 2026-04-19
    const m = line.match(/^-\s+\[([ x])\]\s+(https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*(.+)$/);
    if (!m) continue;

    const url = m[2].trim();
    const company = m[3].trim();
    const rest = m[4];

    // Parse remaining pipe-delimited fields
    const fields = rest.split('|').map(f => f.trim());
    let role = fields[0];
    let status = null;
    let actionDate = null;
    let postedAt = null;

    let location = null;
    let matchTier = null;
    let contextualScore = null;
    let contextualRationale = null;
    let contextualSignals = null;
    for (let i = 1; i < fields.length; i++) {
      const f = fields[i];
      if (f === 'SKIP' || f === 'EXPIRED') status = f;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(f)) actionDate = f;
      else if (/^posted:/.test(f)) postedAt = f.replace('posted:', '');
      else if (/^loc:/.test(f)) location = f.replace('loc:', '').trim() || null;
      else if (/^match:/.test(f)) matchTier = f.replace('match:', '').trim() || null;
      else if (/^llm:/.test(f)) {
        const n = Number.parseFloat(f.replace('llm:', '').trim());
        if (Number.isFinite(n)) contextualScore = n;
      } else if (/^why:/.test(f)) contextualRationale = f.replace('why:', '').trim() || null;
      else if (/^signals:/.test(f)) {
        contextualSignals = f.replace('signals:', '')
          .split(',')
          .map(signal => signal.trim())
          .filter(Boolean);
      }
    }

    const item = {
      done: m[1] === 'x',
      url,
      company,
      role,
      status,
      date: actionDate,
      postedAt,
      location,
      matchTier,
      contextualScore,
      contextualRationale,
      contextualSignals,
      contextualScoreSource: Number.isFinite(contextualScore) ? 'llm' : undefined,
    };

    if (item.status === 'SKIP') skipped.push(item);
    else if (item.status === 'EXPIRED') expired.push(item);
    else if (!item.done) pending.push(item);
  }

  return { pending, skipped, expired };
}

/** Load report summary (archetype, tldr, remote, comp) from a report file. */
export function loadReportSummary(cataBullRoot, reportPath) {
  try {
    const text = asWorkspace(cataBullRoot).read(reportPath);
    if (text == null) return { archetype: '', tldr: '', remote: '', comp: '' };
    let archetype = '', tldr = '', remote = '', comp = '';

    let m;
    if ((m = text.match(RE_ARCHETYPE))) archetype = cleanTableCell(m[1]);
    else if ((m = text.match(RE_ARCHETYPE_COLON))) archetype = cleanTableCell(m[1]);

    if ((m = text.match(RE_TLDR))) tldr = cleanTableCell(m[1]);
    else if ((m = text.match(RE_TLDR_COLON))) tldr = cleanTableCell(m[1]);

    if ((m = text.match(RE_REMOTE))) remote = cleanTableCell(m[1]);
    if ((m = text.match(RE_COMP))) comp = cleanTableCell(m[1]);

    if (tldr.length > 120) tldr = tldr.substring(0, 117) + '...';

    return { archetype, tldr, remote, comp };
  } catch {
    return { archetype: '', tldr: '', remote: '', comp: '' };
  }
}
