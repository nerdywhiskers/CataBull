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

  ws.write(cvPath, payload.tailored_cv_markdown.endsWith('\n')
    ? payload.tailored_cv_markdown
    : payload.tailored_cv_markdown + '\n');
  ws.write(clPath, payload.cover_letter_markdown.endsWith('\n')
    ? payload.cover_letter_markdown
    : payload.cover_letter_markdown + '\n');
  ws.write(qaPath, renderQaMarkdown(payload.qa_pairs, { company, role }));

  return {
    dir,
    paths: { cv: cvPath, coverLetter: clPath, qa: qaPath },
  };
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
