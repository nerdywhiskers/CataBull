#!/usr/bin/env node

/**
 * apply-patches.mjs — apply resolver output to portals.yml + the
 * shipped template at templates/portals.example.yml.
 *
 * Reads `tools/audit/resolved-urls.json`. For each entry the resolver
 * bucketed:
 *
 *   A1.use_ats              — existing portal: swap careers_url to the
 *                             resolved ATS URL; add `api:` line for
 *                             Greenhouse; drop any stale scan_method.
 *   A1.use_websearch_fallback — existing portal: add or update
 *                             scan_method: websearch + scan_query.
 *                             URL stays put.
 *   C.use_ats               — new company: append a fresh block under
 *                             tracked_companies with enabled: false +
 *                             a provenance note.
 *
 * portals.yml AND templates/portals.example.yml are both edited
 * line-by-line so comments and section dividers are preserved (js-yaml
 * round-trips would flatten the template's careful 3,500-line layout).
 *
 * Defaults to dry-run. Pass --apply to actually write. Always writes
 * a .bak file alongside each modified target.
 *
 * Usage:
 *   node tools/audit/apply-patches.mjs                 # dry-run, both
 *   node tools/audit/apply-patches.mjs --apply         # write both
 *   node tools/audit/apply-patches.mjs --portals-only  # local only
 *   node tools/audit/apply-patches.mjs --template-only # template only
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const PORTALS_ONLY = argv.includes('--portals-only');
const TEMPLATE_ONLY = argv.includes('--template-only');

const RESOLVED_PATH = join(__dirname, 'resolved-urls.json');
const PORTALS_PATH = join(REPO, 'portals.yml');
const TEMPLATE_PATH = join(REPO, 'templates', 'portals.example.yml');
const TODAY = new Date().toISOString().slice(0, 10);

// ── Line-level YAML helpers ───────────────────────────────────────────
// portals.yml + the template both follow a strict shape:
//
//   tracked_companies:
//     - name: Foo
//       careers_url: https://...
//       api: https://...
//       enabled: true
//       notes: "..."
//     - name: Bar
//       ...
//
// We never re-parse — we slice line ranges. That preserves comments,
// blank lines, and the manual section dividers in the template.

function findCompanyBlock(lines, name) {
  // Returns { startIdx, endIdx, indent } where startIdx is the `- name: <name>`
  // line and endIdx is the line BEFORE the next `- name:` (or end of file).
  // null if the company isn't in the file.
  const target = `name: ${name}`;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Match both '- name: Foo' and '  - name: Foo' (anchor on - name: prefix)
    if (/^-\s+name:\s+/.test(trimmed)) {
      const n = trimmed.replace(/^-\s+name:\s+/, '').trim();
      if (n === name) { startIdx = i; break; }
    }
  }
  if (startIdx === -1) return null;
  // The leading whitespace of the dash line tells us the block indent.
  // Field lines are indented two more spaces than the dash.
  const dashIndent = lines[startIdx].match(/^(\s*)-/)[1];
  const fieldIndent = dashIndent + '  ';
  let endIdx = lines.length - 1;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Stop at the next `- name:` at the same indent OR a top-level key
    if (/^-\s+name:\s+/.test(trimmed) || (lines[i] && !lines[i].startsWith(fieldIndent) && !lines[i].startsWith(dashIndent + '#') && lines[i].trim() !== '')) {
      endIdx = i - 1;
      break;
    }
  }
  return { startIdx, endIdx, indent: dashIndent, fieldIndent };
}

function findFieldInBlock(lines, block, field) {
  // Returns the line index of `<fieldIndent>field:` within the block,
  // or null if absent.
  const re = new RegExp(`^${block.fieldIndent}${field}:\\s`);
  for (let i = block.startIdx + 1; i <= block.endIdx; i++) {
    if (re.test(lines[i])) return i;
  }
  return null;
}

function setField(lines, block, field, value) {
  // Replace or insert a `field: value` line inside a block. Insertion
  // goes right after `name:` so the order stays predictable (name,
  // careers_url, api/scan_method, scan_query, notes, enabled).
  const newLine = `${block.fieldIndent}${field}: ${value}`;
  const existing = findFieldInBlock(lines, block, field);
  if (existing !== null) {
    lines[existing] = newLine;
    return { changed: true, kind: 'replaced' };
  }
  // Insert after the last "preferred-position" field that exists.
  const order = ['name', 'careers_url', 'api', 'scan_method', 'scan_query', 'notes', 'enabled'];
  const ourIdx = order.indexOf(field);
  let insertAfter = block.startIdx; // default: right after `name:`
  for (let j = ourIdx - 1; j >= 0; j--) {
    const got = findFieldInBlock(lines, block, order[j]);
    if (got !== null) { insertAfter = got; break; }
  }
  lines.splice(insertAfter + 1, 0, newLine);
  // Anything past the insertion point shifts by 1 — caller must
  // refresh block ranges if it makes more edits.
  block.endIdx += 1;
  return { changed: true, kind: 'inserted' };
}

function dropField(lines, block, field) {
  const idx = findFieldInBlock(lines, block, field);
  if (idx === null) return { changed: false };
  lines.splice(idx, 1);
  block.endIdx -= 1;
  return { changed: true, kind: 'dropped' };
}

function findTrackedCompaniesEnd(lines) {
  // Returns the line index AFTER the last entry under tracked_companies.
  // We append new C entries here.
  let inBlock = false;
  let lastEntryEnd = -1;
  let baseIndent = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^tracked_companies\s*:/.test(line)) { inBlock = true; continue; }
    if (!inBlock) continue;
    // Top-level key after tracked_companies — stop. Detect by zero indent.
    if (/^[A-Za-z_]/.test(line)) break;
    const m = line.match(/^(\s*)-\s+name:\s+/);
    if (m) {
      baseIndent = m[1];
      // Walk forward to find this entry's end
      let j = i + 1;
      const fieldIndent = baseIndent + '  ';
      while (j < lines.length) {
        const nxt = lines[j];
        if (nxt.trim() === '') { j++; continue; }
        if (nxt.startsWith(fieldIndent) || nxt.startsWith(baseIndent + '#')) { j++; continue; }
        break;
      }
      lastEntryEnd = j;
      i = j - 1; // resume scan from there
    }
  }
  return { line: lastEntryEnd, indent: baseIndent || '  ' };
}

// ── Patch synthesizers ────────────────────────────────────────────────
function buildA1Patch(entry) {
  // Returns an array of {op, field, value, reason} for a single A1 entry.
  if (!entry.bucket) return [];
  if (entry.bucket.action === 'use_ats') {
    const ops = [
      { op: 'set', field: 'careers_url', value: entry.bucket.careers_url, reason: `ATS detected (${entry.bucket.ats_kind})` },
    ];
    if (entry.bucket.api) {
      ops.push({ op: 'set', field: 'api', value: entry.bucket.api, reason: 'Greenhouse API endpoint' });
    }
    // Drop stale scan_method — direct ATS URL doesn't need a websearch fallback.
    ops.push({ op: 'drop', field: 'scan_method', reason: 'replaced by direct ATS URL' });
    ops.push({ op: 'drop', field: 'scan_query', reason: 'replaced by direct ATS URL' });
    return ops;
  }
  if (entry.bucket.action === 'use_websearch_fallback') {
    return [
      { op: 'set', field: 'scan_method', value: 'websearch', reason: 'no ATS pattern; use websearch fallback' },
      { op: 'set', field: 'scan_query', value: yamlString(entry.bucket.scan_query), reason: 'templated from branded URL' },
    ];
  }
  return [];
}

function yamlString(s) {
  // Single-quote scalars unless they're already safe bareword-ish.
  // Conservative: any non-alphanum char triggers quoting.
  if (!s) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, "''")}'`;
}

function buildCEntry(entry) {
  // Returns an array of YAML lines for a fresh tracked_companies entry.
  if (!entry.bucket || entry.bucket.action !== 'use_ats') return null;
  const lines = [
    `  - name: ${entry.name}`,
    `    careers_url: ${entry.bucket.careers_url}`,
  ];
  if (entry.bucket.api) lines.push(`    api: ${entry.bucket.api}`);
  lines.push(`    notes: "Added via audit ${TODAY}; ${entry.hit_count} JobSpy hits across ${entry.sites.join(', ')}."`);
  lines.push(`    enabled: false`);
  return lines;
}

// ── Main ──────────────────────────────────────────────────────────────
function applyToFile(path, label, a1Entries, cEntries) {
  const original = readFileSync(path, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  let touched = 0;
  let appended = 0;
  const log = [];

  for (const entry of a1Entries) {
    const block = findCompanyBlock(lines, entry.name);
    if (!block) {
      log.push(`  ⚠️  ${entry.name}: not found in ${label} — skipped`);
      continue;
    }
    const ops = buildA1Patch(entry);
    let entryTouched = false;
    for (const op of ops) {
      if (op.op === 'set') {
        const r = setField(lines, block, op.field, op.value);
        if (r.changed) { entryTouched = true; log.push(`  ${r.kind === 'inserted' ? '+' : '~'} ${entry.name}.${op.field}: ${truncate(op.value)}`); }
      } else if (op.op === 'drop') {
        const r = dropField(lines, block, op.field);
        if (r.changed) { entryTouched = true; log.push(`  - ${entry.name}.${op.field} (${op.reason})`); }
      }
    }
    if (entryTouched) touched++;
  }

  if (cEntries.length) {
    const tail = findTrackedCompaniesEnd(lines);
    if (tail.line === -1) {
      log.push(`  ⚠️  could not find end of tracked_companies in ${label} — C entries skipped`);
    } else {
      const banner = [
        '',
        `  # ── Added via audit ${TODAY} ──────────────────────────────────────`,
        `  # ${cEntries.length} new compan${cEntries.length === 1 ? 'y' : 'ies'} surfaced by JobSpy with auto-detected ATS URLs.`,
        `  # All ship enabled: false so users opt in by hand.`,
      ];
      const newLines = [];
      newLines.push(...banner);
      for (const entry of cEntries) {
        const block = buildCEntry(entry);
        if (!block) continue;
        newLines.push('');
        newLines.push(...block);
        log.push(`  + new entry: ${entry.name} (${entry.bucket.careers_url})`);
        appended++;
      }
      lines.splice(tail.line, 0, ...newLines);
    }
  }

  return { lines, touched, appended, log, eol, original };
}

function truncate(s) {
  if (s == null) return '';
  const x = String(s);
  return x.length > 70 ? x.slice(0, 67) + '…' : x;
}

function main() {
  if (!existsSync(RESOLVED_PATH)) {
    console.error(`No resolver output at ${RESOLVED_PATH}. Run "node tools/audit/resolve-urls.mjs" first.`);
    process.exit(1);
  }
  const resolved = JSON.parse(readFileSync(RESOLVED_PATH, 'utf8'));
  const a1Entries = (resolved.a1 || []).filter(e => e.bucket);
  const cEntries = (resolved.c || []).filter(e => e.bucket && e.bucket.action === 'use_ats');

  console.log(`📋 patch plan: ${a1Entries.length} A1 portals, ${cEntries.length} new C entries`);
  console.log(`   (${a1Entries.filter(e => e.bucket.action === 'use_ats').length} A1 ATS swaps, ${a1Entries.filter(e => e.bucket.action === 'use_websearch_fallback').length} A1 websearch fallbacks)`);
  console.log(APPLY ? '   mode: APPLY (will write changes + .bak files)\n' : '   mode: dry-run (use --apply to commit)\n');

  const targets = [];
  if (!TEMPLATE_ONLY) targets.push({ path: PORTALS_PATH, label: 'portals.yml' });
  if (!PORTALS_ONLY) targets.push({ path: TEMPLATE_PATH, label: 'templates/portals.example.yml' });

  for (const t of targets) {
    if (!existsSync(t.path)) {
      console.log(`⏭  skipping ${t.label} — not found`);
      continue;
    }
    console.log(`── ${t.label} ──`);
    const { lines, touched, appended, log, eol, original } = applyToFile(t.path, t.label, a1Entries, cEntries);
    for (const l of log) console.log(l);
    console.log(`  → ${touched} portal${touched === 1 ? '' : 's'} touched, ${appended} new entr${appended === 1 ? 'y' : 'ies'} appended`);
    if (APPLY && (touched > 0 || appended > 0)) {
      copyFileSync(t.path, t.path + '.bak');
      writeFileSync(t.path, lines.join(eol));
      console.log(`  💾 wrote ${t.label} (backup at ${t.label}.bak)`);
    } else if (APPLY) {
      console.log(`  no changes`);
    }
    console.log('');
  }

  if (!APPLY) console.log('Dry-run complete. Re-run with --apply to commit changes.');
}

main();
