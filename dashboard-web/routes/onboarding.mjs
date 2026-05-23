import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { writeProfile, writeCV, writePortals, ensureFromTemplate } from '../lib/writers.mjs';
import { runAgentPrint } from '../lib/agents.mjs';
import { discoverCompanies, buildProvenanceNote, defaultVerifier } from '../../lib/discovery.mjs';
import yaml from 'js-yaml';
import { readFileSync } from 'fs';

// Blank profile structure — mirrors config/profile.example.yml shape but with
// empty values so new users don't inherit the example ("Jane Smith") data.
// Complex sections (archetypes, narrative, proof_points) are left empty for
// the AI agent to fill in from the user's CV after onboarding.
function blankProfile() {
  return {
    candidate: {
      full_name: '', email: '', phone: '', location: '',
      linkedin: '', portfolio_url: '', github: '', twitter: '',
    },
    target_industries: [],
    target_roles: { primary: [], archetypes: [], title_keywords: [] },
    narrative: { headline: '', exit_story: '', superpowers: [], proof_points: [] },
    compensation: { target_range: '', currency: 'USD', minimum: '', location_flexibility: '' },
    location: { country: '', city: '', timezone: '', visa_status: '' },
  };
}

const INDUSTRY_KEYWORDS = {
  tech: ['technology', 'software', 'saas', 'platform', 'cloud', 'startup', 'developer', 'engineering', 'data'],
  ai: ['ai', 'artificial intelligence', 'ml', 'machine learning', 'llm', 'agent', 'voice', 'speech', 'computer vision', 'model'],
  gaming: ['game', 'gaming', 'games', 'interactive', 'unity', 'unreal', 'roblox', 'esports'],
  entertainment: ['entertainment', 'media', 'music', 'audio', 'video', 'creator', 'creative', 'streaming', 'photo', 'image'],
  media: ['media', 'publishing', 'content', 'news', 'creator', 'social', 'community'],
  fintech: ['fintech', 'bank', 'payments', 'finance', 'trading', 'risk', 'neobank', 'broker'],
  ecommerce: ['commerce', 'marketplace', 'retail', 'shopping', 'consumer', 'travel'],
  healthcare: ['health', 'bio', 'medical', 'drug', 'clinical', 'protein', 'life science'],
  education: ['education', 'learning', 'training', 'course', 'school', 'university'],
  climate: ['climate', 'sustainability', 'energy', 'carbon'],
  enterprise: ['enterprise', 'b2b', 'crm', 'erp', 'customer', 'sales', 'support', 'hr', 'business'],
  developer_tools: ['developer', 'devrel', 'api', 'database', 'auth', 'open-source', 'workflow', 'infrastructure', 'observability', 'postgres'],
  automation: ['automation', 'workflow', 'no-code', 'low-code', 'revops', 'gtm', 'business systems'],
  design: ['design', 'creative', 'content', 'video', 'image', 'photo', 'brand'],
  cybersecurity: ['security', 'guardrail', 'auth', 'identity', 'risk'],
};

const JOB_BOARD_QUERIES = {
  linkedin: { label: 'LinkedIn', site: 'linkedin.com/jobs' },
  wellfound: { label: 'Wellfound', site: 'wellfound.com/jobs' },
  ladders: { label: 'Ladders', site: 'theladders.com' },
  remoteok: { label: 'RemoteOK', site: 'remoteok.com' },
};

function normalizeList(values) {
  return Array.isArray(values) ? values.map(v => String(v).trim()).filter(Boolean) : [];
}

function normalizeIndustry(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function unique(values) {
  return [...new Set(normalizeList(values))];
}

function providerKey(company = {}) {
  if (company.provider) return String(company.provider).toLowerCase();
  if (company.scan_method === 'websearch') return 'webfetch';
  const url = `${company.api || ''} ${company.careers_url || ''}`.toLowerCase();
  if (url.includes('greenhouse')) return 'greenhouse';
  if (url.includes('ashbyhq')) return 'ashby';
  if (url.includes('lever.co')) return 'lever';
  if (company.careers_url) return 'webfetch';
  return 'manual';
}

export function inferCompanyIndustries(company = {}) {
  const explicit = normalizeList(company.industries).map(normalizeIndustry);
  if (explicit.length) return unique(explicit);

  const text = `${company.name || ''} ${company.notes || ''} ${company.careers_url || ''} ${company.scan_query || ''}`.toLowerCase();
  const industries = [];
  for (const [industry, terms] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (terms.some(term => text.includes(term))) industries.push(industry);
  }

  return unique(industries);
}

export function buildTitleKeywords(profile = {}, explicit) {
  if (Array.isArray(explicit)) return unique(explicit).slice(0, 40);

  const roleKeywords = normalizeList(profile.target_roles?.primary);
  const cvKeywords = normalizeList(profile.target_roles?.title_keywords);

  return unique([
    ...roleKeywords,
    ...cvKeywords,
  ]).slice(0, 40);
}

function ensureJobBoardQueries(portals, sites, keywords) {
  portals.search_queries = portals.search_queries || [];
  const quoted = keywords.slice(0, 8).map(k => `"${k}"`).join(' OR ');
  if (!quoted) return;
  for (const site of sites) {
    const board = JOB_BOARD_QUERIES[site];
    if (!board) continue;
    const name = `${board.label} - Target roles`;
    let query = portals.search_queries.find(q => String(q.name || '').toLowerCase() === name.toLowerCase());
    if (!query) {
      query = { name, query: `site:${board.site} ${quoted} remote`, enabled: true };
      portals.search_queries.push(query);
    } else {
      query.query = `site:${board.site} ${quoted} remote`;
    }
  }
}

/** Pull a JSON object out of free-form agent output (may be wrapped in
 *  markdown fences or have leading/trailing prose). Returns null if none. */
function extractJson(text) {
  if (!text) return null;
  // Prefer a fenced block if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Pull a JSON array of company candidates out of free-form agent output.
 * Tolerates markdown fences and prose wrapping. Returns [] on any
 * parse failure so callers can treat "no candidates" uniformly.
 *
 * Exported for testing.
 */
export function extractCandidatesArray(text) {
  if (!text) return [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  const match = candidate.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * Sanitize a raw candidate list from the agent into validated entries
 * ready to merge into portals.yml. Filters out entries with missing or
 * malformed fields, dedupes case-insensitively against existingNames
 * (a Set of lowercased names) and against candidates seen earlier in
 * the same array. Caps the output at `target`.
 *
 * `requireUrl` defaults to true (legacy W2 behavior). W7 verified
 * discovery sets it false because the agent proposes names only —
 * the URL is resolved later by lib/discovery's verifier.
 *
 * Exported for testing.
 */
export function sanitizeCandidates(raw, { existingNames = new Set(), target = 25, requireUrl = true } = {}) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    const url = String(entry.careers_url || '').trim();
    if (!name) continue;
    if (requireUrl) {
      if (!url) continue;
      if (!/^https?:\/\//i.test(url)) continue;
    } else if (url && !/^https?:\/\//i.test(url)) {
      // If a URL is supplied in the W7 flow it must still be well-formed;
      // we just don't insist it's present.
      continue;
    }
    const lname = name.toLowerCase();
    if (existingNames.has(lname) || seen.has(lname)) continue;
    seen.add(lname);
    const cleaned = {
      name,
      industries: Array.isArray(entry.industries)
        ? entry.industries.map((s) => String(s).toLowerCase().trim()).filter(Boolean)
        : [],
      notes: String(entry.notes || '').trim().slice(0, 200),
      enabled: true,
    };
    if (url) cleaned.careers_url = url;
    out.push(cleaned);
    if (out.length >= target) break;
  }
  return out;
}

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/onboarding/status', async () => {
    const steps = {
      cv: existsSync(join(root, 'cv.md')),
      profile: existsSync(join(root, 'config', 'profile.yml')),
      profileMd: existsSync(join(root, 'modes', '_profile.md')),
      portals: existsSync(join(root, 'portals.yml')),
      tracker: existsSync(join(root, 'data', 'applications.md')) || existsSync(join(root, 'applications.md')),
    };
    const complete = Object.values(steps).every(Boolean);
    return { complete, steps };
  });

  app.post('/onboarding/cv', async (req) => {
    const { content } = req.body;
    writeCV(root, content);
    return { success: true };
  });

  // Accept a CV file upload (PDF / DOCX / MD / TXT) and return extracted
  // plain text. Does not persist — the client pastes it back into the CV
  // textarea and then hits Save.
  app.post('/onboarding/cv-upload', async (req, reply) => {
    const file = await req.file?.();
    if (!file) return reply.code(400).send({ error: 'No file uploaded' });

    const name = (file.filename || '').toLowerCase();
    const ext = name.split('.').pop();
    const buf = await file.toBuffer();

    try {
      let text = '';
      if (ext === 'pdf') {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buf) });
        const result = await parser.getText();
        text = result.text || '';
      } else if (ext === 'docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer: buf });
        text = result.value || '';
      } else if (ext === 'md' || ext === 'txt' || ext === 'markdown') {
        text = buf.toString('utf-8');
      } else if (ext === 'doc') {
        return reply.code(415).send({ error: 'Old .doc files are not supported. Please save as .docx or PDF.' });
      } else {
        return reply.code(415).send({ error: `Unsupported file type: .${ext}. Use PDF, DOCX, MD, or TXT.` });
      }

      // Tidy whitespace so the parser heuristics have a fighting chance.
      text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      return { success: true, text, filename: file.filename };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to parse: ${err.message}` });
    }
  });

  app.post('/onboarding/profile', async (req) => {
    // Read the existing profile first so we preserve keys the form doesn't
    // touch (notably preferences.agent set by the agent step). Without this
    // merge, saving the profile form wipes the agent preference.
    const existingPath = join(root, 'config', 'profile.yml');
    let existing = {};
    if (existsSync(existingPath)) {
      try { existing = yaml.load(readFileSync(existingPath, 'utf-8')) || {}; } catch { existing = {}; }
    }
    const base = deepMerge(blankProfile(), existing);
    const merged = deepMerge(base, req.body);
    writeProfile(root, merged);

    ensureFromTemplate(root, 'modes/_profile.template.md', 'modes/_profile.md');
    return { success: true };
  });

  app.post('/onboarding/portals', async (req) => {
    const { customFilters, sites, industries } = req.body || {};
    const selectedSites = normalizeList(sites).map(s => s.toLowerCase());
    const selectedIndustries = unique(normalizeList(industries).map(normalizeIndustry));

    // Copy template if portals.yml doesn't exist
    if (!existsSync(join(root, 'portals.yml'))) {
      ensureFromTemplate(root, 'templates/portals.example.yml', 'portals.yml');
    }

    const portals = yaml.load(readFileSync(join(root, 'portals.yml'), 'utf-8')) || {};
    const profilePath = join(root, 'config', 'profile.yml');
    let profile = blankProfile();
    if (existsSync(profilePath)) {
      try { profile = deepMerge(profile, yaml.load(readFileSync(profilePath, 'utf-8')) || {}); } catch {}
    }

    const hasExplicitPositive = Object.prototype.hasOwnProperty.call(customFilters || {}, 'positive');

    if (hasExplicitPositive) {
      portals.title_filter = portals.title_filter || {};
      portals.title_filter.positive = normalizeList(customFilters.positive);
    }

    if (selectedIndustries.length) {
      profile.target_industries = selectedIndustries;
    }

    const titleKeywords = buildTitleKeywords(profile, hasExplicitPositive ? customFilters.positive : undefined);
    if (titleKeywords.length) {
      portals.title_filter = portals.title_filter || {};
      portals.title_filter.positive = titleKeywords;
      // The example portals.yml ships with AI/PM-specific tech-stack
      // negatives (".NET", "iOS", "PHP", "Salesforce Admin", "COBOL", ...)
      // that become pure noise for non-engineering targets. When we
      // generate user-tailored positives, reset negatives to a universal
      // minimum and let the user grow the list themselves if needed.
      portals.title_filter.negative = customFilters?.negative
        || ['Junior', 'Intern'];
      profile.target_roles = {
        ...(profile.target_roles || {}),
        title_keywords: titleKeywords,
      };
    }

    if (selectedIndustries.length || selectedSites.length) {
      const wantedIndustries = new Set(selectedIndustries);
      const directSources = new Set(selectedSites.filter(site => ['greenhouse', 'ashby', 'lever', 'webfetch', 'workable'].includes(site)));
      for (const company of (portals.tracked_companies || [])) {
        const companyIndustries = inferCompanyIndustries(company);
        company.industries = companyIndustries;
        const industryMatch = !wantedIndustries.size || companyIndustries.some(industry => wantedIndustries.has(industry));
        const source = providerKey(company);
        const sourceMatch = !directSources.size || directSources.has(source) || (source === 'webfetch' && directSources.has('workable'));
        company.enabled = industryMatch && sourceMatch;
      }
    }

    // Drop the template's hard-coded AI/PM/Engineer search queries (e.g.
    // "Ashby — AI PM", "Greenhouse — Voice AI") — they're irrelevant for
    // any user whose target role isn't AI engineering. ensureJobBoardQueries
    // immediately rebuilds queries tailored to the user's title keywords
    // for each selected site.
    if (selectedSites.length) {
      portals.search_queries = [];
      ensureJobBoardQueries(portals, selectedSites, titleKeywords);
    }

    if (existsSync(profilePath)) writeProfile(root, profile);
    writePortals(root, portals);
    return { success: true };
  });

  // Run the user's CLI agent in print mode to both (a) reformat the raw
  // CV text into clean markdown and (b) extract structured profile fields
  // — one LLM call for both jobs. Writes cv.md with the cleaned markdown
  // directly so downstream code never sees the messy PDF extraction.
  //
  // On failure, the raw text is saved to cv.md as a fallback so the user
  // doesn't lose their upload.
  app.post('/onboarding/cv-analyze', async (req, reply) => {
    const text = (req.body?.text || '').toString();
    if (!text.trim()) return reply.code(400).send({ error: 'text is required' });

    let preferred = null;
    const profilePath = join(root, 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      try { preferred = yaml.load(readFileSync(profilePath, 'utf-8'))?.preferences?.agent || null; } catch {}
    }
    const agent = preferred || req.body?.agent;

    // Cap at ~16KB to keep agent context usage reasonable even on long CVs.
    const cvText = text.slice(0, 16000);

    const saveRaw = () => { writeCV(root, text); };

    if (!agent) {
      saveRaw();
      return reply.code(400).send({ error: 'No agent configured. Raw CV saved as-is.' });
    }

    const prompt = [
      'You are processing a CV/resume that was pasted or extracted from a PDF/DOCX.',
      '',
      'Output EXACTLY one JSON object with two keys, and NOTHING else (no preamble, no markdown fences, no trailing text):',
      '{',
      '  "cv_markdown": "...",    // Clean, well-formatted markdown. Fix broken line wraps from PDF extraction. Organize into sections with ## headings (Contact, Summary, Experience, Skills, Education, etc. -- only sections that apply). Preserve ALL factual content; do not invent anything.',
      '  "profile": {',
      '    "full_name": "",',
      '    "email": "",',
      '    "phone": "",',
      '    "location": "",        // "City, State" or "City, Country"',
      '    "linkedin": "",        // full URL',
      '    "github": "",          // full URL',
      '    "portfolio_url": "",   // personal site, not social',
      '    "headline": "",        // one-line summary, 8-15 words, written from the CV',
      '    "target_roles": [],    // 1-5 role titles this candidate could credibly target',
      '    "title_keywords": [],  // 8-20 job title search keywords from the resume. Include exact titles, synonyms, and seniority variants. Do not include generic skills unless they appear in likely job titles.',
      '    "inferred_industries": [], // 1-5 likely target industries, lowercase ids such as tech, ai, gaming, entertainment, fintech, healthcare, education, developer_tools, automation',
      '    "superpowers": []      // 3-5 concrete strengths shown in the CV',
      '  }',
      '}',
      '',
      'Rules:',
      '- Use "" or [] when a field is missing. Never hallucinate URLs or phone numbers.',
      '- `cv_markdown` must be valid Markdown, not raw text with \\n. Use real newlines in the JSON string (escaped as \\n).',
      '- Output ONLY the JSON object, starting with { and ending with }.',
      '',
      'CV TEXT:',
      cvText,
    ].join('\n');

    try {
      const out = await runAgentPrint(agent, prompt, root, { timeoutMs: 180000, rejectOnError: true });
      const textOut = out.output || '';
      const data = extractJson(textOut);
      if (!data || !data.profile) {
        saveRaw();
        return reply.code(502).send({ error: 'Agent returned unparseable output', raw: textOut.slice(0, 500) });
      }
      // Write the cleaned markdown if present; otherwise preserve the raw
      // upload so the CV tab has something.
      const cleaned = typeof data.cv_markdown === 'string' && data.cv_markdown.trim() ? data.cv_markdown : text;
      writeCV(root, cleaned);
      return { success: true, profile: data.profile, agent, cv_length: cleaned.length };
    } catch (err) {
      saveRaw();
      return reply.code(502).send({ error: err.message });
    }
  });

  // Runs the archetype / narrative generation prompt headlessly. Agent
  // writes profile.yml and modes/_profile.md directly. Blocking endpoint —
  // client shows a spinner.
  //
  // W2 (docs/archive/SCAN_RELIABILITY.md): company discovery moved to its own
  // route (/onboarding/discover-companies) so this prompt stays focused
  // on profile work and finishes faster. Profile success no longer
  // depends on portal-discovery success.
  app.post('/onboarding/generate-profile', async (req, reply) => {
    let preferred = null;
    const profilePath = join(root, 'config', 'profile.yml');
    if (existsSync(profilePath)) {
      try { preferred = yaml.load(readFileSync(profilePath, 'utf-8'))?.preferences?.agent || null; } catch {}
    }
    const agent = preferred || req.body?.agent;
    if (!agent) return reply.code(400).send({ error: 'No agent configured' });

    const prompt = `Read cv.md and config/profile.yml, then fill in the empty sections of profile.yml (target_industries if blank, target_roles.archetypes, target_roles.title_keywords, narrative.headline if blank, narrative.exit_story if blank, narrative.superpowers, narrative.proof_points). Title keywords must reflect both the resume and target_industries, and should be useful for job title filtering. Then update modes/_profile.md so the "Your Target Roles" archetype table and "Your Adaptive Framing" table reflect those archetypes and proof points (replace the default AI/LLMOps rows). Preserve anything I already wrote in either file. Follow modes/humanizer.md when writing.`;

    // Profile-only is much smaller than the previous combined prompt — 6
    // minutes is plenty. We keep the raw socket timeout aligned with the
    // agent timeout so a slow proxy / Node default can't cut us off.
    const timeoutMs = 360_000;
    reply.raw.setTimeout(timeoutMs + 30_000);
    try {
      const out = await runAgentPrint(agent, prompt, root, { timeoutMs, allowEdits: true, rejectOnError: true });
      return { success: true, agent, summary: (out.output || '').trim().slice(0, 2000) };
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // W7 — Verified discovery at onboarding (docs/archive/DISCOVERY_QUALITY.md).
  //
  // Two-phase flow:
  //   1. Proposer: agent returns up to N candidates as { name, industries,
  //      notes }. NO careers_url — we don't trust agent-invented slugs.
  //   2. Per-candidate verification (lib/discovery.mjs): for each name,
  //      the agent uses WebSearch + WebFetch to find a working ATS URL,
  //      we run a W1 health check on it, then a role-fit pre-flight
  //      against the user's title filter.
  //
  // Survivors merge into portals.yml with provenance notes. Candidates
  // that fail any gate (no URL, broken URL, no current role-fit) are
  // saved disabled with the reason in `notes`.
  app.post('/onboarding/discover-companies', async (req, reply) => {
    let preferred = null;
    const profilePath = join(root, 'config', 'profile.yml');
    let profile = {};
    if (existsSync(profilePath)) {
      try { profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {}; } catch { profile = {}; }
    }
    preferred = profile?.preferences?.agent || null;
    const agent = preferred || req.body?.agent;
    if (!agent) return reply.code(400).send({ error: 'No agent configured' });

    // User-overridable cap. Defaults to 25; clamped between 5 and 50 so
    // we don't spend unbounded agent budget or write a tiny list.
    const requested = Number.parseInt(req.body?.target, 10);
    const configured = Number.parseInt(profile?.preferences?.onboarding_company_target, 10);
    const target = Math.max(5, Math.min(50,
      Number.isFinite(requested) && requested > 0 ? requested
      : Number.isFinite(configured) && configured > 0 ? configured
      : 25,
    ));

    // Pull existing portals so the agent can see what's already there
    // (don't propose duplicates), and so we have the title filter for
    // role-fit pre-flight.
    const portalsPath = join(root, 'portals.yml');
    let portals = {};
    if (existsSync(portalsPath)) {
      try { portals = yaml.load(readFileSync(portalsPath, 'utf-8')) || {}; } catch { portals = {}; }
    }
    portals.tracked_companies = Array.isArray(portals.tracked_companies) ? portals.tracked_companies : [];
    const existingNames = new Set(portals.tracked_companies.map((c) => String(c.name || '').toLowerCase()));
    const titleFilter = portals.title_filter || null;

    const targetIndustries = Array.isArray(profile?.target_industries) ? profile.target_industries : [];
    const targetRoles = Array.isArray(profile?.target_roles?.primary) ? profile.target_roles.primary : [];
    const country = profile?.location?.country || '';

    // Phase 1 — proposer. Agent returns names + reasoning, NO URLs.
    // The verifier handles URL discovery per-candidate so we never save
    // an invented slug.
    const proposerPrompt = [
      `You are proposing job-portal candidates for a CataBull user. Read cv.md and config/profile.yml, then output a JSON array of up to ${target} companies the user should track.`,
      '',
      'Selection criteria, in priority order:',
      `1. The company plausibly hires for ${targetRoles.length ? `the user's target roles (${targetRoles.slice(0, 5).join(', ')})` : 'the user\'s target roles'} on a recurring basis. Match the company's typical job mix to the role mix — don't propose AI-infra or pure SaaS firms for creative/design candidates.`,
      `2. Industry overlap with target_industries${targetIndustries.length ? ` (${targetIndustries.join(', ')})` : ''}.`,
      country ? `3. Geo or remote fit for someone in ${country}; prefer companies with remote-friendly hiring or offices in their region.` : '3. Remote-friendly hiring is a plus.',
      '4. Direct competitors of past employers from the CV are strong candidates.',
      '',
      'Output ONLY a JSON array (no preamble, no markdown fences). Each entry MUST have:',
      '  - name: string (canonical brand name)',
      '  - industries: array of lowercase ids matching target_industries (e.g. ["ai","gaming"])',
      '  - notes: one short sentence explaining why this company fits this user.',
      '',
      'DO NOT include a careers_url. The system will verify each candidate\'s real careers URL via WebSearch as a follow-up step.',
      '',
      `DO NOT propose any of these (already in portals.yml): ${[...existingNames].slice(0, 80).join(', ') || '(none)'}`,
      '',
      `Cap at ${target}. Better to return fewer high-confidence candidates than ${target} guesses. Output the JSON array and nothing else.`,
    ].join('\n');

    // Per the spec this is roughly 5–10x the previous onboarding spend.
    // 20-minute ceiling — proposer is fast (~2 min), verification is the
    // long pole (each candidate triggers WebSearch + WebFetch + parse).
    const timeoutMs = 1_200_000;
    reply.raw.setTimeout(timeoutMs + 30_000);

    let proposed = [];
    try {
      const out = await runAgentPrint(agent, proposerPrompt, root, { timeoutMs: 360_000, allowEdits: false, rejectOnError: true });
      proposed = extractCandidatesArray(out.output || '');
    } catch (err) {
      return reply.code(502).send({ error: `Agent (proposer) failed: ${err.message}` });
    }

    if (proposed.length === 0) {
      return reply.code(502).send({ error: 'Agent returned no parseable candidates.' });
    }

    // requireUrl: false — W7 expects names only.
    const cleaned = sanitizeCandidates(proposed, {
      existingNames,
      target,
      requireUrl: false,
    });

    if (cleaned.length === 0) {
      return reply.code(200).send({
        success: true,
        candidates: [],
        added: 0,
        enabled: 0,
        disabled: 0,
        message: 'No new candidates passed deduping (agent likely re-suggested companies already in portals.yml).',
      });
    }

    // Phase 2 — verify + health + role-fit per candidate.
    // discoverCompanies parallelizes with concurrency 5 by default.
    const verificationResults = await discoverCompanies(cleaned, {
      verify: (name) => defaultVerifier(name, { agent, workspaceRoot: root, timeoutMs: 180_000 }),
      titleFilter,
    });

    let enabledCount = 0;
    let disabledCount = 0;
    const today = new Date().toISOString().slice(0, 10);
    const responseCandidates = [];

    for (let i = 0; i < cleaned.length; i++) {
      const candidate = cleaned[i];
      const result = verificationResults[i];
      if (!result) continue;

      const isEnabled = result.status === 'enabled';
      if (isEnabled) enabledCount++; else disabledCount++;

      const merged = {
        name: candidate.name,
        industries: candidate.industries,
        notes: [candidate.notes, buildProvenanceNote(result, { date: today })].filter(Boolean).join(' | '),
        enabled: isEnabled,
      };
      if (result.careers_url) merged.careers_url = result.careers_url;
      portals.tracked_companies.push(merged);

      responseCandidates.push({
        name: merged.name,
        careers_url: merged.careers_url || null,
        industries: merged.industries,
        notes: merged.notes,
        enabled: merged.enabled,
        status: result.status,
        role_fit: result.role_fit || null,
        provider: result.provider || null,
        verify_confidence: result.verify?.confidence || null,
        health_status: result.health?.status || null,
        health_error: result.health?.error || result.error || null,
      });
    }

    writePortals(root, portals);

    return {
      success: true,
      candidates: responseCandidates,
      added: responseCandidates.length,
      enabled: enabledCount,
      disabled: disabledCount,
      target,
    };
  });

  app.post('/onboarding/agent', async (req, reply) => {
    const name = (req.body?.name || '').toLowerCase();
    if (!name) return reply.code(400).send({ error: 'name is required' });

    // Persist the preferred agent in config/profile.yml under `preferences`,
    // so switching between CLI sessions keeps the user's choice.
    const path = join(root, 'config', 'profile.yml');
    let profile = {};
    if (existsSync(path)) {
      try { profile = yaml.load(readFileSync(path, 'utf-8')) || {}; } catch { profile = {}; }
    }
    profile.preferences = { ...(profile.preferences || {}), agent: name };
    writeProfile(root, profile);
    return { success: true };
  });

  app.post('/onboarding/tracker', async () => {
    const dataDir = join(root, 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, 'applications.md');
    if (!existsSync(path)) {
      writeFileSync(path, `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`);
    }
    return { success: true };
  });
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
