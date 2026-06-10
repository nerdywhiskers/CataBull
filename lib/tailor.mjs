/**
 * lib/tailor.mjs — One-click tailored application bundle (PR 1.5).
 *
 * Bundles three outputs the user actually needs to apply to a role:
 *   1. Tailored CV (markdown — convert to PDF via existing pdf flow)
 *   2. Cover letter (markdown)
 *   3. Common application Q&A (5–8 prefilled answers)
 *
 * Server-side orchestration: one agent prompt yields all three outputs
 * as a single JSON object; we write them to
 * output/tailor-bundles/{posting-slug}/ on disk.
 *
 * Designed for testability — the agent runner is injectable so tests can
 * stub the prompt-call interaction.
 */

import { asWorkspace } from './workspace.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Slugify a company + role pair into a directory-safe identifier.
 * Used for the bundle output directory.
 */
export function tailorSlug(company, role, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const c = norm(company) || 'unknown-company';
  const r = norm(role) || 'unknown-role';
  return `${c}-${r}-${date}`;
}

/**
 * Build the agent prompt that produces a Tailor bundle as one JSON object.
 * Exported for testability.
 */
export function buildTailorPrompt({ company, role, url, jd }) {
  return [
    `You are tailoring a job application kit for the user. Read cv.md, config/profile.yml,`,
    `and modes/_profile.md to understand the user's background.`,
    '',
    `Target role:`,
    `  Company: ${company}`,
    `  Role:    ${role}`,
    url ? `  URL:     ${url}` : null,
    jd ? `  JD excerpt:\n${jd.slice(0, 6000)}` : `  (No JD provided — work from company + role only.)`,
    '',
    'Output EXACTLY one JSON object and NOTHING else (no markdown fences, no preamble):',
    '{',
    '  "tailored_cv_markdown": "...",   // The user\'s full CV reordered + reframed for THIS role. Same factual content, just different emphasis. Use the existing CV section structure (## Contact, ## Summary, ## Experience, etc.). Reorder bullets within each role by relevance to the JD. Tighten the summary to mention this archetype. NEVER invent metrics.',
    '  "cover_letter_markdown": "...",  // 200–300 word cover letter, conversational not corporate. Lead with one specific observation about the company (something real you can derive from their public posture). Tie a concrete user proof point to a specific JD requirement. Close with a clear ask for a conversation. Apply modes/humanizer.md style: no em-dashes, no AI tells, no buzzwords.',
    '  "qa_pairs": [',
    '    { "question": "Tell us about yourself", "answer": "..." },',
    '    { "question": "Why this role?", "answer": "..." },',
    '    { "question": "Why this company?", "answer": "..." },',
    '    { "question": "What is your greatest professional accomplishment?", "answer": "..." },',
    '    { "question": "Where do you see yourself in 3 years?", "answer": "..." },',
    '    { "question": "What is your salary expectation?", "answer": "..." }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- Use real newlines in JSON strings (escaped as \\n).',
    '- Each Q&A answer is 80–150 words, specific to THIS role.',
    '- Salary expectation: pull the range from compensation.target_range in profile.yml. If absent, use a respectful "open to discussing the right offer for the role and scope" framing.',
    '- All proof points must come from cv.md or modes/_profile.md. Never fabricate.',
    '- Output ONLY the JSON object, starting with { and ending with }.',
  ].filter(Boolean).join('\n');
}

/**
 * Strip a JSON object out of free-form agent output.
 * Tolerates markdown fences and prose wrapping.
 */
export function extractTailorPayload(text) {
  if (!text) return null;
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : String(text);
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Validate that an extracted Tailor payload has the three required
 * outputs. Returns null if invalid (so callers can treat "agent gave us
 * unusable output" uniformly).
 */
export function validateTailorPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const cv = String(payload.tailored_cv_markdown || '').trim();
  const cl = String(payload.cover_letter_markdown || '').trim();
  const qa = Array.isArray(payload.qa_pairs) ? payload.qa_pairs : [];
  if (!cv || cv.length < 200) return null;
  if (!cl || cl.length < 100) return null;
  // Require at least 3 well-formed Q&A pairs.
  const validQa = qa.filter((p) => p && typeof p.question === 'string' && p.question.trim() && typeof p.answer === 'string' && p.answer.trim());
  if (validQa.length < 3) return null;
  return {
    tailored_cv_markdown: cv,
    cover_letter_markdown: cl,
    qa_pairs: validQa.map((p) => ({ question: p.question.trim(), answer: p.answer.trim() })),
  };
}

/**
 * Render a Q&A pair list as a single markdown document for the bundle.
 * Pure function — used both server-side (write to disk) and from tests.
 */
export function renderQaMarkdown(qaPairs, { company, role } = {}) {
  const header = `# Application Q&A — ${company || ''} ${role ? '· ' + role : ''}`.trim();
  const body = qaPairs.map((p, i) => `## ${i + 1}. ${p.question}\n\n${p.answer}`).join('\n\n');
  return `${header}\n\n${body}\n`;
}

export function renderTailorMarkdownHtml(markdown, { title = 'Tailored Document' } = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let paragraph = [];

  const flushList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${escapeHtml(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      html.push(`<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; line-height: 1.45; font-size: 11pt; }
    h1 { font-size: 22pt; margin: 0 0 18px; }
    h2 { font-size: 14pt; margin: 18px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    h3 { font-size: 12pt; margin: 14px 0 6px; }
    p { margin: 0 0 9px; }
    ul { margin: 0 0 10px 18px; padding: 0; }
    li { margin: 0 0 5px; }
  </style>
</head>
<body>
${html.join('\n')}
</body>
</html>
`;
}

/**
 * Persist a validated Tailor bundle to the workspace.
 *
 * Returns: { dir, paths: { cv, coverLetter, qa } } — workspace-relative paths.
 */
export function writeTailorBundle(rootOrWorkspace, slug, payload, { company, role } = {}) {
  const ws = asWorkspace(rootOrWorkspace);
  const dir = `output/tailor-bundles/${slug}`;
  ws.mkdir(dir);

  const cvPath = `${dir}/cv.md`;
  const clPath = `${dir}/cover-letter.md`;
  const qaPath = `${dir}/answers.md`;
  const cvHtmlPath = `${dir}/cv.html`;
  const clHtmlPath = `${dir}/cover-letter.html`;
  const cvPdfPath = `${dir}/cv.pdf`;
  const clPdfPath = `${dir}/cover-letter.pdf`;

  ws.write(cvPath, payload.tailored_cv_markdown.endsWith('\n')
    ? payload.tailored_cv_markdown
    : payload.tailored_cv_markdown + '\n');
  ws.write(clPath, payload.cover_letter_markdown.endsWith('\n')
    ? payload.cover_letter_markdown
    : payload.cover_letter_markdown + '\n');
  ws.write(qaPath, renderQaMarkdown(payload.qa_pairs, { company, role }));
  ws.write(cvHtmlPath, renderTailorMarkdownHtml(payload.tailored_cv_markdown, { title: `${company || 'Tailored'} CV` }));
  ws.write(clHtmlPath, renderTailorMarkdownHtml(payload.cover_letter_markdown, { title: `${company || 'Tailored'} Cover Letter` }));

  return {
    dir,
    paths: {
      cv: cvPath,
      coverLetter: clPath,
      qa: qaPath,
      cvHtml: cvHtmlPath,
      coverLetterHtml: clHtmlPath,
      cvPdf: cvPdfPath,
      coverLetterPdf: clPdfPath,
    },
  };
}

function reportSlug(company, role) {
  return [company, role]
    .map((value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40))
    .filter(Boolean)
    .join('-') || 'tailor-bundle';
}

function nextReportNumber(ws) {
  const existing = ws.list('reports', { filter: (entry) => entry.isFile && /^\d+-.*\.md$/i.test(entry.name) });
  const max = existing.reduce((best, entry) => {
    const match = entry.name.match(/^(\d+)-/);
    const n = match ? parseInt(match[1], 10) : 0;
    return Number.isFinite(n) ? Math.max(best, n) : best;
  }, 0);
  return String(max + 1).padStart(3, '0');
}

export function renderTailorReportMarkdown({ company, role, url, slug, dir, paths, payload, date = new Date().toISOString().slice(0, 10) } = {}) {
  const section = renderTailorReportSection({ dir, paths, payload, date });
  return [
    `# Tailor Bundle - ${company || 'Unknown'} - ${role || 'Unknown Role'}`,
    '',
    `**Date:** ${date}`,
    url ? `**URL:** ${url}` : '',
    `**Archetype:** Tailor bundle`,
    `**TL;DR:** Tailored CV, cover letter, and application Q&A generated for ${company || 'this company'} - ${role || 'this role'}.`,
    '',
    `**Bundle directory:** \`${dir || `output/tailor-bundles/${slug || ''}`}\``,
    '',
    section,
  ].filter((line) => line !== '').join('\n') + '\n';
}

export function renderTailorReportSection({ dir, paths, payload, date = new Date().toISOString().slice(0, 10) } = {}) {
  const qa = Array.isArray(payload?.qa_pairs)
    ? payload.qa_pairs.map((item, index) => [
        `### Q${index + 1}. ${item.question || 'Question'}`,
        '',
        String(item.answer || '').trim(),
        '',
      ].join('\n')).join('\n')
    : '';
  return [
    '<!-- catabull-tailor-bundle:start -->',
    '## Tailored Packet',
    '',
    `Generated: ${date}`,
    dir ? `Bundle directory: \`${dir}\`` : '',
    '',
    '## Tailored CV',
    '',
    String(payload?.tailored_cv_markdown || '').trim(),
    '',
    '## Cover Letter',
    '',
    String(payload?.cover_letter_markdown || '').trim(),
    '',
    '## Application Q&A',
    '',
    qa || '_No application Q&A generated._',
    '<!-- catabull-tailor-bundle:end -->',
    '',
  ].filter((line) => line !== '').join('\n');
}

export function appendTailorReportSection(rootOrWorkspace, reportPath, result, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const ws = asWorkspace(rootOrWorkspace);
  const raw = ws.read(reportPath);
  if (raw == null) return null;
  const section = renderTailorReportSection({
    dir: result?.dir,
    paths: result?.paths,
    payload: result?.payload,
    date,
  });
  const stripped = raw.replace(/\n*<!-- catabull-tailor-bundle:start -->[\s\S]*?<!-- catabull-tailor-bundle:end -->\n*/m, '\n');
  ws.write(reportPath, `${stripped.trimEnd()}\n\n${section}\n`);
  return { path: reportPath, appended: true };
}

export function writeTailorReport(rootOrWorkspace, result, { company, role, url, date = new Date().toISOString().slice(0, 10) } = {}) {
  const ws = asWorkspace(rootOrWorkspace);
  const number = nextReportNumber(ws);
  const filename = `${number}-${reportSlug(company, role)}-${date}.md`;
  const path = `reports/${filename}`;
  const markdown = renderTailorReportMarkdown({
    company,
    role,
    url,
    slug: result?.slug,
    dir: result?.dir,
    paths: result?.paths,
    payload: result?.payload,
    date,
  });
  ws.write(path, markdown);
  return { filename, path, number };
}

/**
 * High-level Tailor orchestrator.
 *
 * Inputs:
 *   - { company, role, url, jd } — what to tailor
 *   - { workspace, agent, runAgent } — how to run the agent
 *
 * `runAgent(prompt)` should resolve to the agent's text output. Tests
 * stub this; production wires it to runAgentPrint.
 *
 * Returns: {
 *   slug, dir, paths,
 *   payload,         // the validated agent output (in case caller wants previews)
 * }
 *
 * Throws on agent failure or unparseable output.
 */
export async function runTailor({ company, role, url, jd, workspace, runAgent, slugDate }) {
  if (!company) throw new Error('runTailor: company is required');
  if (!role) throw new Error('runTailor: role is required');
  if (!workspace) throw new Error('runTailor: workspace is required');
  if (typeof runAgent !== 'function') throw new Error('runTailor: runAgent fn is required');

  const ws = asWorkspace(workspace);
  const prompt = buildTailorPrompt({ company, role, url, jd });

  const raw = await runAgent(prompt);
  const parsed = extractTailorPayload(raw);
  const valid = validateTailorPayload(parsed);
  if (!valid) {
    throw new Error('Tailor agent returned unparseable or incomplete output');
  }

  const slug = tailorSlug(company, role, slugDate ? { date: slugDate } : undefined);
  const { dir, paths } = writeTailorBundle(ws, slug, valid, { company, role });
  return { slug, dir, paths, payload: valid };
}
