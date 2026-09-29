#!/usr/bin/env node
/**
 * dedup-tracker.mjs — Remove duplicate entries from applications.md
 *
 * Groups by normalized company + fuzzy role match.
 * Keeps entry with highest score. If discarded entry had more advanced status,
 * preserves that status. Merges notes.
 *
 * Run: node dedup-tracker.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defaultWorkspace } from '../lib/workspace.mjs';
import { canonicalCompanyName, canonicalCompanyRoleKey, sameJobPosting } from '../lib/role-identity.mjs';

// Data root = the user's workspace. CATABULL_WORKSPACE_ROOT (set by the CLI and
// the dashboard when it spawns scripts) wins; otherwise fall back to the package
// dir so a direct run from a git clone keeps working.
const CATA_BULL_ROOT = defaultWorkspace(resolve(dirname(fileURLToPath(import.meta.url)), '..')).root;
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CATA_BULL_ROOT, 'data/applications.md'))
  ? join(CATA_BULL_ROOT, 'data/applications.md')
  : join(CATA_BULL_ROOT, 'applications.md');
const DRY_RUN = process.argv.includes('--dry-run');

// Ensure required directories exist (fresh setup)
mkdirSync(join(CATA_BULL_ROOT, 'data'), { recursive: true });

// Status advancement order (higher = more advanced in pipeline)
// Aplicado > Rechazado because active application > terminal state
const STATUS_RANK = {
  // English canonicals (states.yml labels)
  'skip': 0,
  'discarded': 0,
  'rejected': 1,
  'tailored': 2,
  'evaluated': 2,
  'applied': 3,
  'responded': 4,
  'interview': 5,
  'offer': 6,
  // Spanish aliases — kept for backwards compat with existing tracker data
  'no_aplicar': 0,
  'no aplicar': 0,
  'descartado': 0,
  'descartada': 0,
  'rechazado': 1,  // Terminal — below active states
  'rechazada': 1,
  'evaluada': 2,
  'aplicado': 3,
  'respondido': 4,
  'entrevista': 5,
  'oferta': 6,
};

function normalizeCompany(name) {
  return name.toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function normalizeRole(role) {
  return role.toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 /]/g, '')
    .trim();
}

const ROLE_STOPWORDS = new Set([
  'senior', 'junior', 'lead', 'staff', 'principal', 'head', 'chief',
  'manager', 'director', 'associate', 'intern', 'contractor',
  'remote', 'hybrid', 'onsite',
  'engineer', 'engineering',
]);

const LOCATION_STOPWORDS = new Set([
  'tokyo', 'japan', 'london', 'berlin', 'paris', 'singapore',
  'york', 'francisco', 'angeles', 'seattle', 'austin', 'boston',
  'chicago', 'denver', 'toronto', 'amsterdam', 'dublin', 'sydney',
  'remote', 'global', 'emea', 'apac', 'latam',
]);

function roleMatch(a, b) {
  if (canonicalCompanyRoleKey('', a) === canonicalCompanyRoleKey('', b)) return true;
  const filterStopwords = (words) =>
    words.filter(w => !ROLE_STOPWORDS.has(w) && !LOCATION_STOPWORDS.has(w));

  const wordsA = filterStopwords(normalizeRole(a).split(/\s+/).filter(w => w.length > 2));
  const wordsB = filterStopwords(normalizeRole(b).split(/\s+/).filter(w => w.length > 2));

  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const overlap = wordsA.filter(w => wordsB.some(wb => wb === w));
  const smaller = Math.min(wordsA.length, wordsB.length);
  const ratio = overlap.length / smaller;

  return overlap.length >= 2 && ratio >= 0.6;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num)) return null;
  return {
    num,
    date: parts[2],
    company: parts[3],
    role: parts[4],
    score: parts[5],
    status: parts[6],
    pdf: parts[7],
    report: parts[8],
    notes: parts[9] || '',
    jobUrl: parts[10] || '',
    raw: line,
  };
}

function reportJobUrl(reportCell) {
  const link = String(reportCell || '').match(/\((reports\/[^)]+\.md)\)/);
  if (!link || link[1].includes('..')) return '';
  try {
    const report = readFileSync(join(CATA_BULL_ROOT, link[1]), 'utf8');
    return report.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/m)?.[1]?.replace(/[),.]+$/, '') || '';
  } catch {
    return '';
  }
}

// Read
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to dedup.');
  process.exit(0);
}
const content = readFileSync(APPS_FILE, 'utf-8');
const lines = content.split('\n').map((line) => {
  if (line.trim() === '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |') {
    return '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | Job URL |';
  }
  if (line.trim() === '|---|------|---------|------|-------|--------|-----|--------|-------|') {
    return '|---|------|---------|------|-------|--------|-----|--------|-------|---------|';
  }
  return line;
});

// Parse all entries
const entries = [];
const entryLineMap = new Map(); // num → line index
let backfilled = 0;

for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('|')) continue;
  const app = parseAppLine(lines[i]);
  if (app && app.num > 0) {
    if (!app.jobUrl) {
      const recovered = reportJobUrl(app.report);
      if (recovered) {
        app.jobUrl = recovered;
        const parts = lines[i].split('|').map((part) => part.trim());
        parts.splice(parts.length - 1, 0, recovered);
        lines[i] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
        app.raw = lines[i];
        backfilled++;
      }
    }
    entries.push(app);
    entryLineMap.set(app.num, i);
  }
}

console.log(`📊 ${entries.length} entries loaded`);

// Build duplicate clusters across all rows. Canonical URL identity can match
// even when an aggregator supplied the wrong company/title metadata; otherwise
// retain the legacy same-company fuzzy-role behavior.
const parent = entries.map((_, index) => index);
const findRoot = (index) => {
  while (parent[index] !== index) {
    parent[index] = parent[parent[index]];
    index = parent[index];
  }
  return index;
};
const union = (a, b) => {
  const rootA = findRoot(a);
  const rootB = findRoot(b);
  if (rootA !== rootB) parent[rootB] = rootA;
};
for (let i = 0; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const sameCompanyRole = canonicalCompanyName(entries[i].company) === canonicalCompanyName(entries[j].company)
      && roleMatch(entries[i].role, entries[j].role);
    if (sameJobPosting(entries[i], entries[j]) || sameCompanyRole) union(i, j);
  }
}

const clusters = new Map();
for (let i = 0; i < entries.length; i++) {
  const root = findRoot(i);
  if (!clusters.has(root)) clusters.set(root, []);
  clusters.get(root).push(entries[i]);
}

let removed = 0;
const linesToRemove = new Set();
for (const cluster of clusters.values()) {
  if (cluster.length < 2) continue;

  // Keep the one with highest score.
  cluster.sort((a, b) => parseScore(b.score) - parseScore(a.score));
  const keeper = cluster[0];

  let bestStatusRank = STATUS_RANK[keeper.status.toLowerCase()] || 0;
  let bestStatus = keeper.status;
  for (let k = 1; k < cluster.length; k++) {
    const rank = STATUS_RANK[cluster[k].status.toLowerCase()] || 0;
    if (rank > bestStatusRank) {
      bestStatusRank = rank;
      bestStatus = cluster[k].status;
    }
  }

  const lineIdx = entryLineMap.get(keeper.num);
  if (lineIdx !== undefined) {
    const parts = lines[lineIdx].split('|').map(s => s.trim());
    if (bestStatus !== keeper.status) {
      parts[6] = bestStatus;
      console.log(`  📝 #${keeper.num}: status promoted to "${bestStatus}" (from #${cluster.find(e => e.status === bestStatus)?.num})`);
    }
    if (!keeper.jobUrl) {
      const recoveredUrl = cluster.find((entry) => entry.jobUrl)?.jobUrl || '';
      if (recoveredUrl) {
        while (parts.length < 12) parts.splice(parts.length - 1, 0, '');
        parts[10] = recoveredUrl;
      }
    }
    lines[lineIdx] = '| ' + parts.slice(1, -1).join(' | ') + ' |';
  }

  for (let k = 1; k < cluster.length; k++) {
    const dup = cluster[k];
    const duplicateLineIdx = entryLineMap.get(dup.num);
    if (duplicateLineIdx !== undefined) {
      linesToRemove.add(duplicateLineIdx);
      removed++;
      console.log(`🗑️  Remove #${dup.num} (${dup.company} — ${dup.role}, ${dup.score}) → kept #${keeper.num} (${keeper.score})`);
    }
  }
}

// Remove lines (in reverse order to preserve indices)
const sortedRemoveIndices = [...linesToRemove].sort((a, b) => b - a);
for (const idx of sortedRemoveIndices) {
  lines.splice(idx, 1);
}

console.log(`\n📊 ${removed} duplicates removed, ${backfilled} job URLs backfilled`);

if (!DRY_RUN && (removed > 0 || backfilled > 0)) {
  copyFileSync(APPS_FILE, APPS_FILE + '.bak');
  writeFileSync(APPS_FILE, lines.join('\n'));
  console.log('✅ Written to applications.md (backup: applications.md.bak)');
} else if (DRY_RUN) {
  console.log('(dry-run — no changes written)');
} else {
  console.log('✅ No duplicates found');
}
