#!/usr/bin/env node

/**
 * test-tailor.mjs — Unit tests for lib/tailor.mjs (PR 1.5).
 *
 * No real agent runs — the runAgent function is stubbed and the
 * workspace points at a temp dir.
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const VERBOSE = process.argv.includes('--verbose');

let passed = 0;
let failed = 0;
let total = 0;

function assert(cond, msg) {
  total++;
  if (cond) {
    passed++;
    if (VERBOSE) console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

async function assertRejects(fn, expectedSubstring, msg) {
  total++;
  try {
    await fn();
    failed++;
    console.log(`  ❌ ${msg} (expected to throw)`);
  } catch (err) {
    if (expectedSubstring && !err.message.includes(expectedSubstring)) {
      failed++;
      console.log(`  ❌ ${msg} (threw but missing "${expectedSubstring}": ${err.message})`);
    } else {
      passed++;
      if (VERBOSE) console.log(`  ✅ ${msg}`);
    }
  }
}

const {
  tailorSlug,
  buildTailorPrompt,
  extractTailorPayload,
  validateTailorPayload,
  renderQaMarkdown,
  renderTailorMarkdownHtml,
  renderTailorReportMarkdown,
  renderTailorReportSection,
  appendTailorReportSection,
  writeTailorBundle,
  writeTailorReport,
  runTailor,
} = await import('../lib/tailor.mjs');
const { LocalWorkspace } = await import('../lib/workspace.mjs');

console.log('\nlib/tailor.mjs');

function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'catabull-tailor-test-'));
  const ws = new LocalWorkspace(dir);
  return Promise.resolve()
    .then(() => fn(ws, dir))
    .finally(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
}

// ── 1. tailorSlug ─────────────────────────────────────────────────────

console.log('\n1. tailorSlug');

assert(tailorSlug('Anthropic', 'Staff Engineer', { date: '2026-05-07' }) === 'anthropic-staff-engineer-2026-05-07', 'normal slug');
assert(tailorSlug('Acme, Inc.', 'C++ Engineer', { date: '2026-05-07' }) === 'acme-cplusplus-engineer-2026-05-07', 'slug uses canonical company aliases and preserves technical role tokens');
assert(tailorSlug('C# Labs, Inc.', '.NET Engineer', { date: '2026-05-07' }) !== tailorSlug('C Labs, Inc.', 'NET Engineer', { date: '2026-05-07' }), 'technical-token roles and companies cannot overwrite each other');
assert(tailorSlug('  Whitespace  ', '  Role  ', { date: '2026-05-07' }) === 'whitespace-role-2026-05-07', 'whitespace stripped');
assert(tailorSlug('', '', { date: '2026-05-07' }) === 'unknown-company-unknown-role-2026-05-07', 'empty fallbacks');
assert(tailorSlug('A'.repeat(100), 'B'.repeat(100), { date: '2026-05-07' }).length <= 100, 'caps each segment to 40 chars');
assert(/^\w+-\w+-\d{4}-\d{2}-\d{2}$/.test(tailorSlug('Co', 'Role')), 'default date is today and ISO');

// ── 2. buildTailorPrompt ─────────────────────────────────────────────

console.log('\n2. buildTailorPrompt');

const prompt = buildTailorPrompt({ company: 'Anthropic', role: 'Staff', url: 'https://x', jd: 'job description here' });
assert(prompt.includes('Anthropic'), 'prompt includes company');
assert(prompt.includes('Staff'), 'prompt includes role');
assert(prompt.includes('https://x'), 'prompt includes URL');
assert(prompt.includes('tailored_cv_markdown'), 'prompt declares CV field');
assert(prompt.includes('cover_letter_markdown'), 'prompt declares cover letter field');
assert(prompt.includes('qa_pairs'), 'prompt declares Q&A field');
assert(prompt.includes('humanizer.md'), 'prompt references humanizer style guide');

const noJd = buildTailorPrompt({ company: 'Acme', role: 'Eng' });
assert(noJd.includes('No JD provided'), 'gracefully handles missing JD');

// JD truncation
const hugeJd = 'x'.repeat(20000);
const truncated = buildTailorPrompt({ company: 'Co', role: 'R', jd: hugeJd });
assert(truncated.length < 12000, 'JD excerpt capped (sanity bound on prompt length)');

// ── 3. extractTailorPayload ──────────────────────────────────────────

console.log('\n3. extractTailorPayload');

const goodPayload = {
  tailored_cv_markdown: '# CV\n\nA full markdown CV with at least 200 chars of content. '.repeat(5),
  cover_letter_markdown: 'Dear hiring team,\n\nI am writing to apply...'.padEnd(150, '.'),
  qa_pairs: [
    { question: 'Tell us about yourself', answer: 'Eight years of software engineering experience at scale.' },
    { question: 'Why this role?', answer: 'The platform team is exactly where my interests live.' },
    { question: 'Salary expectation?', answer: 'Open to discussing the right offer for the role and scope.' },
  ],
};

const json = JSON.stringify(goodPayload);
assert(extractTailorPayload(json) !== null, 'plain JSON extracted');
assert(extractTailorPayload('```json\n' + json + '\n```') !== null, 'fenced JSON extracted');
assert(extractTailorPayload('Sure, here you go:\n' + json + '\nLet me know if you need anything else.') !== null, 'JSON in prose extracted');
assert(extractTailorPayload('') === null, 'empty input → null');
assert(extractTailorPayload('not json at all') === null, 'non-JSON → null');
assert(extractTailorPayload('{ "broken: json }') === null, 'malformed JSON → null');

// ── 4. validateTailorPayload ─────────────────────────────────────────

console.log('\n4. validateTailorPayload');

const valid = validateTailorPayload(goodPayload);
assert(valid !== null, 'valid payload accepted');
assert(valid.qa_pairs.length === 3, 'all 3 Q&A pairs preserved');

assert(validateTailorPayload(null) === null, 'null → null');
assert(validateTailorPayload({}) === null, 'empty object → null');
assert(validateTailorPayload({ ...goodPayload, tailored_cv_markdown: 'too short' }) === null, 'CV too short → null');
assert(validateTailorPayload({ ...goodPayload, cover_letter_markdown: '' }) === null, 'missing cover letter → null');
assert(validateTailorPayload({ ...goodPayload, qa_pairs: [{ question: 'Q' }] }) === null, 'fewer than 3 valid Q&A → null');

// Filter out malformed Q&A entries but accept if ≥3 valid remain
const mixed = {
  ...goodPayload,
  qa_pairs: [
    ...goodPayload.qa_pairs,
    { question: '', answer: 'no question' },
    null,
    { question: 'Real?', answer: 'Yes' },
  ],
};
const validMixed = validateTailorPayload(mixed);
assert(validMixed !== null, 'mixed Q&A accepted when valid count >= 3');
assert(validMixed.qa_pairs.length === 4, 'malformed Q&A entries dropped, valid kept');

// Trim
const padded = validateTailorPayload({
  ...goodPayload,
  tailored_cv_markdown: '   ' + goodPayload.tailored_cv_markdown + '   ',
});
assert(!padded.tailored_cv_markdown.startsWith(' '), 'CV trimmed');

// ── 5. renderQaMarkdown ──────────────────────────────────────────────

console.log('\n5. renderQaMarkdown');

const qaMd = renderQaMarkdown(goodPayload.qa_pairs, { company: 'Anthropic', role: 'Staff' });
assert(qaMd.startsWith('# Application Q&A'), 'header starts with Q&A header');
assert(qaMd.includes('Anthropic'), 'company in header');
assert(qaMd.includes('Staff'), 'role in header');
assert(qaMd.includes('## 1. Tell us about yourself'), 'Q&A uses ##-numbered headings');
assert(qaMd.endsWith('\n'), 'document ends with newline');

const cvHtml = renderTailorMarkdownHtml('# CV\n\n- Built useful things', { title: 'CV' });
assert(cvHtml.includes('<h1>CV</h1>'), 'tailor markdown HTML renders h1');
assert(cvHtml.includes('<li>Built useful things</li>'), 'tailor markdown HTML renders bullets');
assert(!cvHtml.includes('<script'), 'tailor markdown HTML escapes raw markup');

// ── 6. writeTailorBundle ─────────────────────────────────────────────

console.log('\n6. writeTailorBundle');

await withTempWorkspace((ws) => {
  const result = writeTailorBundle(ws, 'acme-eng-2026-05-07', valid, { company: 'Acme', role: 'Eng' });
  assert(result.dir === 'output/tailor-bundles/acme-eng-2026-05-07', 'dir relative to workspace');
  assert(ws.exists(result.paths.cv), 'cv.md written');
  assert(ws.exists(result.paths.coverLetter), 'cover-letter.md written');
  assert(ws.exists(result.paths.qa), 'answers.md written');
  assert(ws.exists(result.paths.cvHtml), 'cv.html written for PDF generation');
  assert(ws.exists(result.paths.coverLetterHtml), 'cover-letter.html written for PDF generation');
  assert(ws.exists(result.paths.cvDoc), 'cv.doc written for Word download');
  assert(ws.exists(result.paths.coverLetterDoc), 'cover-letter.doc written for Word download');
  assert(result.paths.cvPdf.endsWith('/cv.pdf'), 'cv PDF path returned');
  assert(result.paths.coverLetterPdf.endsWith('/cover-letter.pdf'), 'cover letter PDF path returned');
  assert(ws.read(result.paths.cv).includes('# CV'), 'cv content preserved');
  assert(ws.read(result.paths.qa).includes('Tell us about yourself'), 'Q&A rendered');
  assert(ws.read(result.paths.cv).endsWith('\n'), 'cv ends with newline');
});

await withTempWorkspace((ws) => {
  ws.write('reports/001-existing-2026-05-06.md', '# Existing\n');
  const bundle = writeTailorBundle(ws, 'acme-eng-2026-05-07', valid, { company: 'Acme', role: 'Eng' });
  const report = writeTailorReport(ws, { ...bundle, slug: 'acme-eng-2026-05-07', payload: valid }, {
    company: 'Acme',
    role: 'Eng',
    url: 'https://example.com/job',
    date: '2026-05-07',
  });
  assert(report.filename === '002-acme-eng-2026-05-07.md', 'tailor report uses next report number');
  assert(ws.exists(report.path), 'tailor report written');
  const rawReport = ws.read(report.path);
  assert(rawReport.includes('**Company:** Acme'), 'tailor report includes canonical company metadata');
  assert(rawReport.includes('**Role:** Eng'), 'tailor report includes canonical role metadata');
  assert(rawReport.includes('**URL:** https://example.com/job'), 'tailor report includes posting URL');
  assert(rawReport.includes('Bundle directory: `output/tailor-bundles/acme-eng-2026-05-07`'), 'tailor report includes bundle directory');
  assert(rawReport.includes('## Application Q&A'), 'tailor report embeds application Q&A section');
});

await withTempWorkspace((ws) => {
  ws.write('reports/001-acme-2026-05-07.md', '# Existing Eval\n\nScore: 4.1/5\n');
  const bundle = writeTailorBundle(ws, 'acme-eng-2026-05-07', valid, { company: 'Acme', role: 'Eng' });
  const appended = appendTailorReportSection(ws, 'reports/001-acme-2026-05-07.md', { ...bundle, payload: valid }, { date: '2026-05-07' });
  assert(appended?.appended === true, 'appendTailorReportSection appends to existing report');
  const once = ws.read('reports/001-acme-2026-05-07.md');
  appendTailorReportSection(ws, 'reports/001-acme-2026-05-07.md', { ...bundle, payload: valid }, { date: '2026-05-08' });
  const twice = ws.read('reports/001-acme-2026-05-07.md');
  assert(twice.includes('# Existing Eval'), 'appendTailorReportSection preserves evaluation report body');
  assert((twice.match(/catabull-tailor-bundle:start/g) || []).length === 1, 'appendTailorReportSection replaces prior tailor section on rerun');
  assert(once.includes('Generated: 2026-05-07'), 'appendTailorReportSection writes generation date');
});

const reportMarkdown = renderTailorReportMarkdown({
  company: 'Acme',
  role: 'Eng',
  url: 'https://example.com/job',
  slug: 'acme-eng-2026-05-07',
  dir: 'output/tailor-bundles/acme-eng-2026-05-07',
  paths: { cvPdf: 'output/tailor-bundles/acme-eng-2026-05-07/cv.pdf' },
  payload: valid,
  date: '2026-05-07',
});
assert(reportMarkdown.includes('**TL;DR:** Tailored CV'), 'tailor report exposes TLDR summary');
assert(reportMarkdown.includes('## Tailored Packet'), 'tailor report includes tailored packet section');

const sectionMarkdown = renderTailorReportSection({
  dir: 'output/tailor-bundles/acme-eng-2026-05-07',
  paths: { qa: 'output/tailor-bundles/acme-eng-2026-05-07/answers.md' },
  payload: valid,
  date: '2026-05-07',
});
assert(sectionMarkdown.includes('### Q1.'), 'tailor section embeds Q&A answers instead of requiring a download');

// ── 7. runTailor (orchestration with stub agent) ─────────────────────

console.log('\n7. runTailor orchestration');

await withTempWorkspace(async (ws) => {
  // Happy path
  const stubAgent = async () => JSON.stringify(goodPayload);
  const result = await runTailor({
    company: 'Acme',
    role: 'Engineer',
    url: 'https://example.com/job',
    workspace: ws,
    runAgent: stubAgent,
    slugDate: '2026-05-07',
  });
  assert(result.slug === 'acme-engineer-2026-05-07', 'slug computed correctly');
  assert(ws.exists(result.paths.cv), 'cv saved on disk');
  assert(result.payload.qa_pairs.length === 3, 'payload returned to caller');
});

await withTempWorkspace(async (ws) => {
  // Agent returns prose around JSON
  const stubAgent = async () => `Here is your bundle:\n\`\`\`json\n${JSON.stringify(goodPayload)}\n\`\`\``;
  const result = await runTailor({
    company: 'Co',
    role: 'R',
    workspace: ws,
    runAgent: stubAgent,
    slugDate: '2026-05-07',
  });
  assert(result.payload.qa_pairs.length === 3, 'fenced JSON parses');
});

await withTempWorkspace(async (ws) => {
  // Agent returns junk
  await assertRejects(
    () => runTailor({
      company: 'Co',
      role: 'R',
      workspace: ws,
      runAgent: async () => 'not json',
      slugDate: '2026-05-07',
    }),
    'unparseable',
    'unparseable agent output rejected'
  );
});

await withTempWorkspace(async (ws) => {
  // Agent returns valid JSON but missing required fields
  await assertRejects(
    () => runTailor({
      company: 'Co',
      role: 'R',
      workspace: ws,
      runAgent: async () => JSON.stringify({ tailored_cv_markdown: 'tiny' }),
      slugDate: '2026-05-07',
    }),
    'unparseable or incomplete',
    'incomplete payload rejected'
  );
});

await assertRejects(
  () => runTailor({ company: '', role: 'R', workspace: {}, runAgent: () => {} }),
  'company is required',
  'missing company rejected'
);

await assertRejects(
  () => runTailor({ company: 'A', role: '', workspace: {}, runAgent: () => {} }),
  'role is required',
  'missing role rejected'
);

await assertRejects(
  () => runTailor({ company: 'A', role: 'B', workspace: null, runAgent: () => {} }),
  'workspace is required',
  'missing workspace rejected'
);

// ── DONE ──────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed} / ${total}`);
if (failed > 0) {
  console.log(`Failed: ${failed}`);
  process.exitCode = 1;
} else {
  console.log('All passed ✓');
}
