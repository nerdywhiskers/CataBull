import { toast } from '../components/toast.mjs';
import { runPrompt, getCurrentAgent } from '../views/chat.mjs';

const MODES = [
  { id: 'auto-pipeline', label: 'Auto Pipeline', description: 'Evaluate pasted JD text or a job post in one pass.', slash: 'auto-pipeline', group: 'Evaluate', needsTarget: true, targetKind: 'jd-text', placements: ['palette'] },
  { id: 'evaluate', label: 'Tailor', description: 'Score a role from a job URL and draft a tailored CV when it is a strong fit.', slash: 'evaluate', group: 'Tailor', needsTarget: true, targetKind: 'url', placements: ['palette', 'pipeline-row'] },
  { id: 'pdf', label: 'Generate PDF', description: 'Create a tailored PDF for a strong-fit role.', slash: 'pdf', group: 'Apply', needsTarget: true, targetKind: 'url', placements: ['palette', 'offer-row'] },
  { id: 'apply', label: 'Start Apply Mode', description: 'Prepare to fill the application form for a role.', slash: 'apply', group: 'Apply', needsTarget: true, targetKind: 'url', placements: ['palette', 'offer-row'] },
  { id: 'interview-prep', label: 'Prep Interview', description: 'Build interview prep for a company and role.', slash: 'interview-prep', group: 'Interview', needsTarget: true, targetKind: 'company', placements: ['palette', 'app-row'] },
  { id: 'outreach', label: 'Outreach', description: 'Find contacts and draft intros for a company.', slash: 'outreach', group: 'Research', needsTarget: true, targetKind: 'company', placements: ['palette', 'pipeline-row'] },
  { id: 'training', label: 'Evaluate Training', description: 'Assess a course or certification idea.', slash: 'training', group: 'Explore', needsTarget: true, targetKind: 'jd-text', placements: ['palette'] },
  { id: 'project', label: 'Evaluate Project', description: 'Assess a portfolio project idea.', slash: 'project', group: 'Explore', needsTarget: true, targetKind: 'jd-text', placements: ['palette'] },
  { id: 'pipeline', label: 'Process Pipeline', description: 'Work through pending URLs in the pipeline.', slash: 'pipeline', group: 'Workflow', needsTarget: false, targetKind: 'none', placements: ['palette', 'quick-actions'] },
  { id: 'scan', label: 'Scan Jobs', description: 'Run the job scan across tracked companies.', slash: 'scan', group: 'Workflow', needsTarget: false, targetKind: 'none', placements: ['palette', 'quick-actions'] },
  { id: 'batch', label: 'Batch Process', description: 'Run batch processing for multiple roles.', slash: 'batch', group: 'Workflow', needsTarget: false, targetKind: 'none', placements: ['palette', 'quick-actions'] },
  { id: 'deep', label: 'Deep Research', description: 'Research a company in depth before you apply.', slash: 'deep', group: 'Research', needsTarget: true, targetKind: 'company', placements: ['palette', 'pipeline-row', 'company-card'] },
  { id: 'tracker', label: 'Tracker Snapshot', description: 'Review the applications tracker and stats.', slash: 'tracker', group: 'Workflow', needsTarget: false, targetKind: 'none', placements: ['palette'] },
  { id: 'patterns', label: 'Pattern Analysis', description: 'Analyze rejection patterns across the tracker.', slash: 'patterns', group: 'Analytics', needsTarget: false, targetKind: 'none', placements: ['palette', 'quick-actions', 'analytics'] },
  { id: 'followup', label: 'Follow-up Analysis', description: 'Review follow-up urgency and draft next steps.', slash: 'followup', group: 'Analytics', needsTarget: false, targetKind: 'none', placements: ['palette', 'analytics'] },
];

const MODES_BY_ID = new Map(MODES.map(mode => [mode.id, mode]));
let promptQueue = Promise.resolve();

function firstNonEmpty(...values) {
  return values.find(value => typeof value === 'string' && value.trim())?.trim() || '';
}

function quoteIfNeeded(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function compactLines(lines) {
  return lines.filter(Boolean).join('\n').trim();
}

function resolveTarget(mode, context = {}) {
  if (!mode?.needsTarget) return '';
  if (mode.targetKind === 'url') return firstNonEmpty(context.url, context.target);
  if (mode.targetKind === 'company') return firstNonEmpty(context.company, context.target);
  if (mode.targetKind === 'jd-text') return firstNonEmpty(context.text, context.target);
  return '';
}

function buildPrompt(mode, context = {}) {
  const target = resolveTarget(mode, context);
  const command = mode.targetKind === 'jd-text'
    ? `/catabull ${mode.slash}`
    : mode.needsTarget && target
    ? `/catabull ${mode.slash} ${quoteIfNeeded(target)}`
    : `/catabull ${mode.slash}`;

  const extraLines = [];
  if (context.text && (mode.targetKind === 'jd-text' || !mode.needsTarget)) extraLines.push(context.text);
  if (context.role && !command.includes(context.role)) extraLines.push(`Role: ${context.role}`);
  if (context.url && mode.targetKind !== 'url') extraLines.push(`URL: ${context.url}`);
  if (context.company && mode.targetKind !== 'company') extraLines.push(`Company: ${context.company}`);

  return compactLines([command, ...extraLines]);
}

// Inline expansions for non-Claude agents (codex, opencode). The `/catabull`
// slash command only resolves inside Claude Code via .claude/skills/. Other
// agents read whatever we hand them as plain text, so we replace the slash
// with self-contained instructions that point at the same modes/*.md files
// the Claude skill would have loaded.
//
// Each entry takes (target, context) and returns the prompt body. Modes not
// listed fall through to `genericInlinePrompt`.

function joinSections(sections) {
  return sections.filter(section => section != null && section !== '').join('\n\n').trim();
}

function metaBlock(pairs) {
  return compactLines(pairs.map(([label, value]) => value ? `${label}: ${value}` : ''));
}

const INLINE_EXPANSIONS = {
  evaluate: (target, ctx) => joinSections([
    'You are running the catabull "evaluate" workflow.',
    'Read these project files first using your file-reading tool:\n' +
      '  1. modes/_shared.md   (scoring rules, A-G blocks, report format)\n' +
      '  2. modes/_profile.md  (user customizations and archetypes)\n' +
      '  3. modes/humanizer.md (writing style)\n' +
      '  4. cv.md              (candidate background)',
    'Then evaluate this offer following _shared.md exactly. Save the report to reports/{###}-{company-slug}-{YYYY-MM-DD}.md using the next available report number.',
    metaBlock([['URL', target], ['Company', ctx.company], ['Role', ctx.role]]),
  ]),

  deep: (target, ctx) => joinSections([
    'You are running the catabull "deep" company-research workflow.',
    'Read modes/deep.md using your file-reading tool and follow its 6-axis research protocol exactly. Use WebSearch / WebFetch to fill in the answers.',
    metaBlock([['Company', target], ['Role', ctx.role], ['URL', ctx.url]]),
  ]),

  outreach: (target, ctx) => joinSections([
    'You are running the catabull "outreach" workflow.',
    'Read modes/outreach.md using your file-reading tool and follow its contact-discovery + LinkedIn-intro-drafting protocol exactly. Save any drafts under data/outreach/ as the mode file specifies.',
    metaBlock([['Company', target], ['Role', ctx.role], ['URL', ctx.url]]),
  ]),

  pdf: (target, ctx) => joinSections([
    'You are running the catabull "pdf" CV-generation workflow.',
    'Read modes/_shared.md and modes/pdf.md using your file-reading tool and follow them exactly. Generate the tailored CV via templates/cv-template.html and generate-pdf.mjs.',
    metaBlock([['URL', target], ['Company', ctx.company], ['Role', ctx.role]]),
  ]),

  apply: (target, ctx) => joinSections([
    'You are running the catabull "apply" workflow (live application assistant).',
    'Read modes/_shared.md and modes/apply.md using your file-reading tool, then follow them. Use Playwright (browser_navigate + browser_snapshot) to read the application form, generate answers, and present them for review.',
    metaBlock([['URL', target], ['Company', ctx.company], ['Role', ctx.role]]),
  ]),

  'interview-prep': (target, ctx) => joinSections([
    'You are running the catabull "interview-prep" workflow.',
    'Read modes/interview-prep.md using your file-reading tool and follow it exactly. Pull from interview-prep/story-bank.md where relevant.',
    metaBlock([['Company', target], ['Role', ctx.role], ['URL', ctx.url]]),
  ]),
};

function genericInlinePrompt(mode, target, ctx) {
  const sharedNeeded = ['auto-pipeline', 'pdf', 'apply', 'pipeline', 'scan', 'batch'].includes(mode.slash);
  const meta = metaBlock([
    [mode.targetKind === 'url' ? 'URL' : mode.targetKind === 'company' ? 'Company' : 'Target', target],
    ['Role', ctx.role],
    ...(mode.targetKind !== 'url' ? [['URL', ctx.url]] : []),
    ...(mode.targetKind !== 'company' ? [['Company', ctx.company]] : []),
  ]);
  return joinSections([
    `You are running the catabull "${mode.slash}" workflow.`,
    sharedNeeded
      ? `Read modes/_shared.md and modes/${mode.slash}.md using your file-reading tool, then execute the workflow exactly as those files describe.`
      : `Read modes/${mode.slash}.md using your file-reading tool, then execute the workflow exactly as that file describes.`,
    ctx.text || '',
    meta,
  ]);
}

function buildInlinePrompt(mode, context = {}) {
  const target = resolveTarget(mode, context);
  const builder = INLINE_EXPANSIONS[mode.slash];
  return builder ? builder(target, context) : genericInlinePrompt(mode, target, context);
}

export function listModes() {
  return MODES.slice();
}

export function getMode(modeId) {
  return MODES_BY_ID.get(modeId) || null;
}

export function modesForPlacement(placement) {
  return MODES.filter(mode => mode.placements.includes(placement));
}

export function prefillModeTarget(modeId, context = {}) {
  const mode = getMode(modeId);
  return resolveTarget(mode, context);
}

export function targetLabel(modeId) {
  const mode = getMode(modeId);
  if (!mode?.needsTarget) return '';
  if (mode.targetKind === 'url') return 'Job URL';
  if (mode.targetKind === 'company') return 'Company';
  if (mode.targetKind === 'jd-text') return 'Paste text';
  return 'Target';
}

export function targetPlaceholder(modeId) {
  const mode = getMode(modeId);
  if (!mode?.needsTarget) return '';
  if (mode.targetKind === 'url') return 'https://company.com/jobs/...';
  if (mode.targetKind === 'company') return 'Company name';
  if (mode.targetKind === 'jd-text') return 'Paste job description or prompt context';
  return 'Enter target';
}

export function runModePrompt(modeId, context = {}, runOptions = {}) {
  const mode = getMode(modeId);
  if (!mode) {
    toast(`Unknown mode: ${modeId}`, 'error');
    return Promise.resolve(false);
  }

  const target = resolveTarget(mode, context);
  if (mode.needsTarget && !target) {
    toast(`${mode.label} needs a ${targetLabel(modeId).toLowerCase()}.`, 'error');
    return Promise.resolve(false);
  }

  // Claude Code resolves `/catabull` via the project skill at
  // .claude/skills/catabull/SKILL.md. Codex / OpenCode have no equivalent
  // skill loader, so for those agents we hand-expand the slash command into
  // self-contained instructions that point at the same mode files.
  const agent = (typeof getCurrentAgent === 'function' ? getCurrentAgent() : '') || 'claude';
  const prompt = agent === 'claude'
    ? buildPrompt(mode, context)
    : buildInlinePrompt(mode, context);

  // Always show the user the clean slash form, regardless of what the
  // underlying agent actually receives. Without this, codex/opencode/gemini
  // users see the entire multi-paragraph inline expansion rendered as if
  // they typed it themselves.
  const displayText = buildPrompt(mode, context);

  promptQueue = promptQueue
    .catch(() => {})
    .then(() => runPrompt(prompt, { ...runOptions, displayText }));
  return promptQueue;
}
