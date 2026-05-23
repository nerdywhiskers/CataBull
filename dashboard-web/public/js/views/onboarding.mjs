import { api } from '../api.mjs';
import { toast } from '../components/toast.mjs';
import { confirmModal } from '../components/confirm.mjs';
import { renderMarkdown } from '../components/markdown.mjs';
import { INDUSTRIES } from '../lib/industries.mjs';

const SCAN_LIMIT_STORAGE_KEY = 'catabull-scan-limit';
let scanState = 'idle'; // idle | running | done | error | skipped
let scanResultCount = 0;
let scanError = '';

const STEPS = ['welcome', 'agent', 'cv', 'profile', 'portals', 'generate', 'scan', 'done'];
const STEP_LABELS = {
  welcome: 'Welcome',
  agent: 'Agent',
  cv: 'CV',
  profile: 'Profile',
  portals: 'Portals',
  generate: 'Generate',
  scan: 'Initial Scan',
  done: 'Done',
};
let currentStep = 0;
let status = {};
let profileData = {};
let availableAgents = [];
let supportedAgents = ['claude', 'codex', 'opencode', 'gemini', 'hermes', 'openclaw'];
let selectedAgent = '';
let agentTestResult = null; // { ok, version, error }
let generateState = 'idle'; // idle | running | done | error
let generateError = '';
// Sub-state for company discovery (W2). Runs after profile generation
// succeeds. We track it separately so a discovery failure doesn't block
// the user from continuing — their profile is already saved.
let discoverState = 'idle'; // idle | running | done | error | skipped
let discoverError = '';
let discoverResult = null; // { added, enabled, disabled, candidates: [...] }
let selectedIndustries = [];
let portalTitleKeywords = null;
let settingsData = null;

const AGENT_SETUP_DOC_URL = 'https://github.com/your-github-user/catabull#supported-cli-agents';
const AGENT_INSTALL_HELP = {
  claude: {
    label: 'Claude Code',
    help: '<code>npm install -g @anthropic-ai/claude-code</code>',
  },
  codex: {
    label: 'Codex CLI',
    help: 'see <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">github.com/openai/codex</a>',
  },
  opencode: {
    label: 'OpenCode',
    help: '<code>npm install -g opencode-ai</code>',
  },
  gemini: {
    label: 'Gemini CLI',
    help: '<code>npm install -g @google/gemini-cli</code>',
  },
  hermes: {
    label: 'Hermes Agent',
    help: '<code>curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</code> or see <a href="https://github.com/NousResearch/hermes-agent" target="_blank" rel="noreferrer">GitHub</a>',
  },
  openclaw: {
    label: 'OpenClaw',
    help: '<code>npm install -g openclaw@latest</code> or see <a href="https://docs.openclaw.ai/install/index" target="_blank" rel="noreferrer">install docs</a>',
  },
};

// Job aggregator sources shown during the portals step. The scanner hits
// Ashby/Greenhouse/Lever directly; LinkedIn/Wellfound/Ladders get added to
// search_queries for the WebSearch fallback path.
const JOB_SITES = [
  { id: 'greenhouse', label: 'Greenhouse', recommended: true, description: 'Direct API (fast, reliable)' },
  { id: 'ashby', label: 'Ashby', recommended: true, description: 'Direct API (fast, reliable)' },
  { id: 'lever', label: 'Lever', recommended: true, description: 'Direct API (fast, reliable)' },
  { id: 'workable', label: 'Workable', recommended: false, description: 'Search-based' },
  { id: 'linkedin', label: 'LinkedIn', recommended: false, description: 'Search-based (results may be stale)' },
  { id: 'wellfound', label: 'Wellfound', recommended: false, description: 'Search-based (startups)' },
  { id: 'ladders', label: 'Ladders', recommended: false, description: 'Search-based (senior roles, $100K+)' },
  { id: 'remoteok', label: 'Remote OK', recommended: false, description: 'Search-based (remote only)' },
];

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function renderAgentInstallList(names) {
  return `
    <ul style="padding-left:20px;margin:8px 0 0 0;line-height:1.8">
      ${names.map((name) => {
        const item = AGENT_INSTALL_HELP[name] || { label: name, help: `Install <code>${esc(name)}</code> and make sure it is on PATH.` };
        return `<li>${esc(item.label)}: ${item.help}</li>`;
      }).join('')}
      <li>More setup notes: <a href="${AGENT_SETUP_DOC_URL}" target="_blank" rel="noreferrer">supported CLI agents</a></li>
    </ul>
  `;
}

function normalizeLines(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map(item => item.trim())
    .filter(Boolean);
}

function profileKeywords() {
  const roles = Array.isArray(profileData.target_roles?.primary) ? profileData.target_roles.primary : [];
  const keywords = Array.isArray(profileData.target_roles?.title_keywords) ? profileData.target_roles.title_keywords : [];
  return [...new Set([...keywords, ...roles].map(item => String(item || '').trim()).filter(Boolean))];
}

function dots() {
  // Renders the bottom progress bar: step pills + an escape-hatch "Start
  // over" link for users whose previous run left bad/partial data behind.
  const pills = STEPS.map((id, i) => {
    const cls = `step-pill${i === currentStep ? ' active' : ''}${i < currentStep ? ' done' : ''}`;
    return `
      <div class="${cls}" role="listitem">
        <span class="step-dot"></span>
        <span class="step-label">${STEP_LABELS[id] || id}</span>
      </div>
    `;
  }).join('');
  return `
    <div class="onboarding-progress" role="list" aria-label="Onboarding progress">
      ${pills}
      <button type="button" class="onboarding-reset-btn" id="onboarding-reset-btn" title="Wipe your local data and restart onboarding from scratch">Start over</button>
    </div>
  `;
}

function renderWelcome() {
  return `
    <div class="onboarding-header">
      <div class="onboarding-brand">
        <img class="onboarding-logo" src="/CataBull-logo.svg" alt="" width="36" height="36" />
        <h1><span>Cata</span>Bull</h1>
      </div>
      <h2 class="onboarding-subtitle">AI-powered job search pipeline. Let's get you set up.</h2>
      <div class="onboarding-define">
        <p class="define-headword">CataBull <span class="define-pron">/ˈkat·ə·bool/</span> <span class="define-pos">verb</span></p>
        <p class="define-meaning">to catapult oneself into a new and better job.</p>
        <p class="define-example">"After two years stuck, she CataBulled into a team she loves."</p>
      </div>
    </div>
    <div class="onboarding-step active">
      <p class="step-description" style="font-size:15px;line-height:1.6">
        We'll walk through a CV upload, profile generation, portals, and an optional first scan. Takes about 5 minutes.
      </p>
      <p class="step-description" style="font-size:14px;line-height:1.6;color:var(--subtext)">
        For the AI-driven steps (CV parsing, archetype generation, deep scans) we recommend
        <strong>Claude Code</strong> or <strong>Codex</strong> as your CLI agent — both run locally and produce the best results. <strong>OpenCode</strong> and Gemini work too. You can pick yours on the next step.
      </p>
      <div class="step-actions step-actions-center">
        <button class="btn btn-primary btn-lg" id="start-btn">Start</button>
      </div>
    </div>
  `;
}

function renderAgentStep() {
  const connected = availableAgents.length > 0;
  const missing = supportedAgents.filter(a => !availableAgents.includes(a));
  const agentReady = connected && Boolean(selectedAgent);

  const agentRows = supportedAgents.map(name => {
    const detected = availableAgents.includes(name);
    const checked = name === selectedAgent ? 'checked' : '';
    const disabled = detected ? '' : 'disabled';
    const badge = detected
      ? '<span style="font-size:11px;color:var(--green);margin-left:8px">detected</span>'
      : '<span style="font-size:11px;color:var(--subtext0);margin-left:8px">not found</span>';
    return `
      <label class="agent-row" style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:8px;cursor:${detected ? 'pointer' : 'not-allowed'};opacity:${detected ? '1' : '0.55'}">
        <input type="radio" name="agent-pick" value="${name}" ${checked} ${disabled}>
        <span style="font-weight:500;font-family:'SF Mono',monospace">${name}</span>
        ${badge}
      </label>
    `;
  }).join('');

  const testBlock = agentTestResult ? `
    <div class="card" style="margin-bottom:16px;border-left:3px solid ${agentTestResult.ok ? 'var(--green)' : 'var(--red)'}">
      <p style="font-weight:600;margin-bottom:4px">${agentTestResult.ok ? '✓ ' + esc(selectedAgent) + ' works' : '✗ Test failed'}</p>
      ${agentTestResult.ok
        ? `<p style="font-size:12px;color:var(--subtext);font-family:monospace">${esc(agentTestResult.version || '')}</p>`
        : `<p style="font-size:12px;color:var(--subtext)">${esc(agentTestResult.error || 'Unknown error')}</p>`}
    </div>
  ` : '';

  const missingHelp = missing.length ? `
    <details style="margin-top:12px;font-size:12px;color:var(--subtext)">
      <summary style="cursor:pointer">Install a missing agent (${missing.join(', ')})</summary>
      ${renderAgentInstallList(missing)}
    </details>` : '';

  const body = connected ? `
    <div class="onboarding-tip">A detected CLI agent is required before continuing. It powers CV parsing, archetype generation, tailoring, and full job evaluations.</div>
    <p class="step-description">CataBull uses a CLI agent to draft reports, refine your profile, and evaluate jobs. Pick the one you want as the default. The test button is optional and helps catch PATH or login issues early.</p>
    <div class="card" style="margin-bottom:16px">
      ${agentRows}
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-sm" id="test-agent-btn" ${selectedAgent ? '' : 'disabled'}>Test <code>${esc(selectedAgent || '...')}</code></button>
        <button class="btn btn-sm" id="recheck-agent-btn">Re-check PATH</button>
      </div>
      ${missingHelp}
    </div>
    ${testBlock}
  ` : `
    <p class="step-description">CataBull needs one of these CLI agents on your PATH. Without an agent, reports and profile refinement won't work.</p>
    <div class="card" style="margin-bottom:16px;border-left:3px solid var(--red)">
      <p style="font-weight:600;margin-bottom:8px">✗ No agent detected</p>
      <p style="font-size:13px;color:var(--subtext);margin-bottom:8px">Install one of:</p>
      <div style="font-size:13px;color:var(--subtext)">${renderAgentInstallList(supportedAgents)}</div>
      <p style="font-size:13px;color:var(--subtext);margin-top:8px">After installing, click <em>Re-check PATH</em>.</p>
      <div style="margin-top:8px"><button class="btn btn-sm" id="recheck-agent-btn">Re-check PATH</button></div>
    </div>
  `;

  return `
    <div class="onboarding-step active">
      <h3 class="step-title">AI Agent</h3>
      ${body}
      <div class="step-actions">
        <button class="btn" id="back-btn">← Back</button>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary" id="agent-continue-btn" ${agentReady ? '' : 'disabled'}>${connected ? 'Continue' : 'Install an agent to continue'}</button>
        </div>
      </div>
    </div>
  `;
}

function renderCVStep() {
  const hasAgent = availableAgents.length > 0;
  const tip = hasAgent
    ? `💡 Upload your CV or resume — the more detail (past roles, metrics, projects), the richer your profile and reports will be. When you click Save, the AI agent will clean up the formatting and pre-fill the next step automatically.`
    : `⚠ No CLI agent detected. Your CV or resume will be saved as-is and you'll need to fill in the next step manually. Go back and install an agent for automatic extraction.`;

  return `
    <div class="onboarding-step active">
      <h3 class="step-title">Your CV or Resume</h3>
      <div class="onboarding-tip">${tip}</div>

      <div class="cv-dropzone" id="cv-dropzone">
        <div class="cv-dropzone-icon" aria-hidden="true">📄</div>
        <p class="cv-dropzone-title">Drag &amp; drop your CV, cover letter, or other context files</p>
        <p class="cv-dropzone-hint">PDF, DOCX, MD, or TXT — multiple files OK; each becomes a section</p>
        <label class="btn" for="cv-file-input" style="cursor:pointer">Upload files</label>
        <input type="file" id="cv-file-input" accept=".pdf,.docx,.md,.txt,.markdown" multiple style="display:none">
        <span id="cv-file-status" class="cv-file-status"></span>
      </div>

      <p class="cv-or-paste">— or paste it below —</p>
      <textarea class="form-textarea cv-paste" id="cv-input" placeholder="Paste your CV or resume here."></textarea>

      <div class="cv-notes-block">
        <label for="cv-notes-input" class="cv-notes-label">Notes &amp; additional context (optional)</label>
        <p class="cv-notes-hint">Anything not in your CV worth knowing — career pivots, target roles, location constraints, comp expectations, motivations, side projects. Free-form. The agent reads this alongside your CV when generating your profile.</p>
        <textarea class="form-textarea cv-notes-input" id="cv-notes-input" placeholder="e.g. Looking to pivot from ML research to applied AI PM. Need remote-first or Berlin-based. Targeting $180k+ base."></textarea>
      </div>

      <div id="cv-status-bar" class="onboarding-status" style="display:none">
        <span class="spinner"></span>
        <span id="cv-status-text">Analyzing your CV...</span>
        <button class="btn btn-sm" id="cv-skip-ai-btn" style="margin-left:auto">Skip — save raw</button>
      </div>

      <div id="cv-preview-area" class="cv-preview" style="display:none">
        <div class="markdown-body" id="cv-preview-content"></div>
      </div>

      <div class="step-actions">
        <button class="btn" id="back-btn">← Back</button>
        <div style="display:flex;gap:8px">
          <button class="btn" id="preview-cv-btn">Preview</button>
          <button class="btn btn-primary" id="save-cv-btn" disabled>Save & Continue</button>
        </div>
      </div>
    </div>
  `;
}

function renderProfileStep() {
  const c = profileData.candidate || {};
  const loc = profileData.location || {};
  const nar = profileData.narrative || {};
  const comp = profileData.compensation || {};
  return `
    <div class="onboarding-step active">
      <h3 class="step-title">About You</h3>
      <div class="onboarding-tip">💡 Any field you fill in is kept verbatim; anything you leave blank the agent will generate from your CV at the end of onboarding.</div>
      <p class="step-description">Confirm the details we pre-filled from your CV. Only <strong>name</strong>, <strong>email</strong>, and <strong>target roles</strong> are required — everything else is optional.</p>

      <div class="card" style="margin-bottom:16px">
        <div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="p-name" value="${esc(c.full_name)}"></div>
        <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="p-email" value="${esc(c.email)}"></div>
        <div class="form-group"><label class="form-label">Phone (optional)</label><input class="form-input" id="p-phone" value="${esc(c.phone)}"></div>
        <div class="form-group"><label class="form-label">Location (city, state)</label><input class="form-input" id="p-location" value="${esc(c.location)}"></div>
        <div class="form-group"><label class="form-label">LinkedIn (optional)</label><input class="form-input" id="p-linkedin" placeholder="linkedin.com/in/yourname" value="${esc(c.linkedin)}"></div>
        <div class="form-group"><label class="form-label">GitHub (optional)</label><input class="form-input" id="p-github" placeholder="github.com/yourname" value="${esc(c.github)}"></div>
        <div class="form-group"><label class="form-label">Portfolio URL (optional)</label><input class="form-input" id="p-portfolio" placeholder="https://yourname.dev" value="${esc(c.portfolio_url)}"></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="form-group"><label class="form-label">Country</label><input class="form-input" id="p-country" placeholder="United States" value="${esc(loc.country)}"></div>
        <div class="form-group"><label class="form-label">Timezone</label><input class="form-input" id="p-timezone" placeholder="PST" value="${esc(loc.timezone)}"></div>
        <div class="form-group"><label class="form-label">Visa status</label><input class="form-input" id="p-visa" placeholder="No sponsorship needed" value="${esc(loc.visa_status)}"></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="form-group"><label class="form-label">What roles are you targeting? (one per line)</label><textarea class="form-textarea" id="p-roles" rows="3" placeholder="Art Director\nCreative Technologist">${(profileData.target_roles?.primary || []).join('\n')}</textarea></div>
        <div class="form-group"><label class="form-label">Headline <span style="color:var(--subtext0);font-weight:400">(optional — agent will generate if blank)</span></label><input class="form-input" id="p-headline" placeholder="ML Engineer turned AI product builder" value="${esc(nar.headline)}"></div>
        <div class="form-group"><label class="form-label">Exit story <span style="color:var(--subtext0);font-weight:400">(optional — agent will generate if blank)</span></label><textarea class="form-textarea" id="p-exit" rows="2" placeholder="What makes you unique in one or two sentences.">${esc(nar.exit_story)}</textarea></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="form-group"><label class="form-label">Target Salary Range</label><input class="form-input" id="p-salary" placeholder="$150K-200K" value="${esc(comp.target_range)}"></div>
        <div class="form-group"><label class="form-label">Minimum (walk-away)</label><input class="form-input" id="p-min-salary" placeholder="$120K" value="${esc(comp.minimum)}"></div>
        <div class="form-group"><label class="form-label">Location flexibility (optional)</label><input class="form-input" id="p-loc-flex" placeholder="Remote preferred, 1 week/month on-site" value="${esc(comp.location_flexibility)}"></div>
      </div>

      <div class="step-actions">
        <button class="btn" id="back-btn">← Back</button>
        <button class="btn btn-primary" id="save-profile-btn" disabled>Save & Continue</button>
      </div>
    </div>
  `;
}

function renderPortalsStep() {
  if (!selectedIndustries.length) {
    const saved = Array.isArray(profileData.target_industries) ? profileData.target_industries : [];
    const inferred = Array.isArray(profileData.target_roles?.inferred_industries) ? profileData.target_roles.inferred_industries : [];
    selectedIndustries = saved.length ? saved : inferred;
  }
  if (!Array.isArray(portalTitleKeywords)) portalTitleKeywords = profileKeywords();

  const industryRows = INDUSTRIES.map(industry => `
    <button type="button" class="industry-pill${selectedIndustries.includes(industry.id) ? ' selected' : ''}" data-industry="${industry.id}" aria-pressed="${selectedIndustries.includes(industry.id) ? 'true' : 'false'}" title="${esc(industry.description)}">
      <span class="industry-pill-label">${esc(industry.label)}</span>
      <span class="industry-pill-desc">${esc(industry.description)}</span>
    </button>
  `).join('');

  const siteRows = JOB_SITES.map(s => `
    <button type="button" class="site-pill${s.recommended ? ' selected' : ''}" data-site="${s.id}" aria-pressed="${s.recommended ? 'true' : 'false'}" title="${esc(s.description)}">
      <span class="site-pill-label">
        ${esc(s.label)}
        ${s.recommended ? '<span class="site-pill-tag">recommended</span>' : ''}
      </span>
      <span class="site-pill-desc">${esc(s.description)}</span>
    </button>
  `).join('');

  const secrets = settingsData?.secrets || {};
  const provider = settingsData?.webSearchProvider || 'auto';
  const order = settingsData?.webSearchOrder || 'brave,serper,scrape';
  const providerOption = (value, label) => `<option value="${value}"${provider === value ? ' selected' : ''}>${label}</option>`;
  const orderOption = (value, label) => `<option value="${value}"${order === value ? ' selected' : ''}>${label}</option>`;
  const configuredHint = (secret) => secret?.configured ? `Configured via ${esc(secret.source || '.env')}. Leave blank to keep it.` : 'Optional';

  const roles = profileData.target_roles?.primary || [];
  const keywords = portalTitleKeywords;
  const inferredBlurb = roles.length
    ? `We'll enable a curated list of companies matching your target roles (${roles.slice(0, 3).map(esc).join(', ')}${roles.length > 3 ? `, +${roles.length - 3} more` : ''}) out of ~120 pre-configured companies.`
    : `We'll enable companies that match the industries you select.`;

  return `
    <div class="onboarding-step active">
      <h3 class="step-title">Job Portals</h3>
      <div class="onboarding-tip">💡 Greenhouse / Ashby / Lever give the fastest, most reliable results — they're queried as direct APIs. The search-based sources are broader but can be stale or rate-limited.</div>
      <p class="step-description">Pick your target industries and sources. Industries decide which company portals are active; your CV-derived roles become the starting title keywords.</p>

      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0 0 12px 0">Target Industries</h3>
        <div class="industry-pill-grid">${industryRows}</div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0 0 12px 0">Sources</h3>
        <div class="industry-pill-grid">${siteRows}</div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0 0 8px 0">Search Providers (optional)</h3>
        <p style="font-size:13px;color:var(--subtext);margin:0 0 12px 0">Quick Scan uses direct ATS APIs and does not need keys. Deep Scan uses WebSearch providers to find roles outside your tracked company APIs. Keys are saved to <code>.env</code> and hidden after save.</p>
        <div class="form-group">
          <label class="form-label">Brave Search API key <span style="color:var(--subtext0);font-weight:400">(<a href="https://api-dashboard.search.brave.com/app/keys" target="_blank" rel="noreferrer">get key</a>)</span></label>
          <input class="form-input" id="portal-brave-key" type="password" autocomplete="off" placeholder="${esc(configuredHint(secrets.braveApiKey))}">
        </div>
        <div class="form-group">
          <label class="form-label">Serper API key <span style="color:var(--subtext0);font-weight:400">(<a href="https://serper.dev/api-key" target="_blank" rel="noreferrer">get key</a>)</span></label>
          <input class="form-input" id="portal-serper-key" type="password" autocomplete="off" placeholder="${esc(configuredHint(secrets.serperApiKey))}">
        </div>
        <div class="form-group">
          <label class="form-label">WebSearch provider</label>
          <select class="form-select" id="portal-web-search-provider">
            ${providerOption('auto', 'Auto')}
            ${providerOption('brave', 'Brave')}
            ${providerOption('serper', 'Serper')}
            ${providerOption('scrape', 'Scrape fallback')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Auto provider order</label>
          <select class="form-select" id="portal-web-search-order">
            ${orderOption('brave,serper,scrape', 'Brave, Serper, scrape')}
            ${orderOption('serper,brave,scrape', 'Serper, Brave, scrape')}
            ${orderOption('brave,scrape', 'Brave, scrape')}
            ${orderOption('serper,scrape', 'Serper, scrape')}
            ${orderOption('scrape', 'Scrape only')}
          </select>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0 0 8px 0">Title Keywords</h3>
        <textarea class="form-textarea" id="portal-keywords" rows="4" placeholder="Art Director&#10;Creative Technologist&#10;Game Designer">${keywords.map(esc).join('\n')}</textarea>
        <h3 style="font-size:14px;font-weight:600;color:var(--subtext);margin:0 0 8px 0">Companies</h3>
        <p style="font-size:13px;color:var(--text);margin-bottom:6px">${inferredBlurb}</p>
        <p style="font-size:12px;color:var(--subtext0);margin:0">You can add more anytime — open the terminal and ask the agent: <em>"add Foo to my portals"</em>.</p>
      </div>

      <div class="step-actions">
        <button class="btn" id="back-btn">← Back</button>
        <button class="btn btn-primary" id="setup-portals-btn">Set Up Portals & Continue</button>
      </div>
    </div>
  `;
}


function renderDiscoverBlock() {
  // Sub-section rendered once profile generation has succeeded. Shows
  // either a spinner, a completed summary, or an error — but never
  // blocks Continue. Profile is already saved at this point.
  if (discoverState === 'idle') return '';
  if (discoverState === 'running') {
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="onboarding-status" style="display:flex">
          <span class="spinner"></span>
          <span>Finding tailored companies and verifying each one…</span>
        </div>
        <p style="font-size:12px;color:var(--subtext0);margin:12px 0 0 0">The agent proposes up to 25 companies that plausibly hire for your roles, then verifies each careers URL via WebSearch and checks for current matching postings. Takes a few minutes — running once now means fewer broken portals later.</p>
      </div>`;
  }
  if (discoverState === 'done' && discoverResult) {
    const { added, enabled, disabled } = discoverResult;
    if (added === 0) {
      return `
        <div class="card" style="margin-bottom:16px;border-left:3px solid var(--yellow)">
          <p style="font-weight:600;margin-bottom:6px">No new companies added</p>
          <p style="font-size:13px;color:var(--subtext);margin:0">${esc(discoverResult.message || 'The agent did not propose anything new.')}</p>
        </div>`;
    }
    // W7 — disabled count breaks down further; surface the most common
    // reasons so the user understands why some candidates landed disabled.
    const cands = Array.isArray(discoverResult.candidates) ? discoverResult.candidates : [];
    const reasonCounts = cands.reduce((acc, c) => {
      if (c.enabled) return acc;
      const key = c.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const reasonLabels = {
      disabled_no_url: 'no working URL found',
      disabled_health: 'careers page failed health check',
      disabled_no_fit: 'no current postings match your title filter',
      disabled_empty: 'careers page returned no postings',
      error: 'verification error',
    };
    const reasonText = Object.entries(reasonCounts)
      .map(([k, v]) => `${v} ${reasonLabels[k] || k}`)
      .join(', ');
    return `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--green)">
        <p style="font-weight:600;margin-bottom:6px">✓ Added ${added} compan${added === 1 ? 'y' : 'ies'} to your portals</p>
        <p style="font-size:13px;color:var(--subtext);margin:0">
          ${enabled} enabled${disabled > 0 ? `, ${disabled} added but disabled (${reasonText}) — review on the Portals page` : ''}.
        </p>
      </div>`;
  }
  if (discoverState === 'skipped') {
    return `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--subtext0)">
        <p style="font-weight:600;margin-bottom:6px">Company discovery skipped</p>
        <p style="font-size:13px;color:var(--subtext);margin:0">You can run it later from the Portals page.</p>
      </div>`;
  }
  // error
  return `
    <div class="card" style="margin-bottom:16px;border-left:3px solid var(--yellow)">
      <p style="font-weight:600;margin-bottom:6px">Company discovery failed (profile is still saved)</p>
      <p style="font-size:13px;color:var(--subtext);margin:0 0 10px 0">${esc(discoverError || 'Unknown error')}</p>
      <p style="font-size:12px;color:var(--subtext0);margin:0">You can continue — your profile and existing portals are unaffected. Re-run discovery later from the Portals page.</p>
    </div>`;
}

function renderGenerateStep() {
  const agent = selectedAgent || availableAgents[0] || 'your agent';
  const hasAgent = availableAgents.length > 0;

  let body = '';
  if (!hasAgent) {
    body = `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--yellow)">
        <p style="font-weight:600;margin-bottom:6px">⚠ No agent detected</p>
        <p style="font-size:13px;color:var(--subtext);margin:0">Archetypes and narrative stay blank until you install a CLI agent. You can finish onboarding and generate these later.</p>
      </div>`;
  } else if (generateState === 'running') {
    body = `
      <div class="card" style="margin-bottom:16px">
        <div class="onboarding-status" style="display:flex">
          <span class="spinner"></span>
          <span>Generating profile with ${esc(agent)}... (typically 1-3 minutes)</span>
        </div>
        <p style="font-size:12px;color:var(--subtext0);margin:12px 0 0 0">The agent is reading your CV and profile, then writing archetypes, superpowers, proof points, headline, and exit story to <code>config/profile.yml</code> and <code>modes/_profile.md</code>. Please don't close this tab.</p>
      </div>`;
  } else if (generateState === 'done') {
    body = `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--green)">
        <p style="font-weight:600;margin-bottom:6px">✓ Profile generated</p>
        <p style="font-size:13px;color:var(--subtext);margin:0">Archetypes and narrative are saved to <code>config/profile.yml</code> and <code>modes/_profile.md</code>.</p>
      </div>` + renderDiscoverBlock();
  } else if (generateState === 'error') {
    body = `
      <div class="card" style="margin-bottom:16px;border-left:3px solid var(--red)">
        <p style="font-weight:600;margin-bottom:6px">Generation failed</p>
        <p style="font-size:13px;color:var(--subtext);margin:0 0 10px 0">${esc(generateError || 'Unknown error')}</p>
        <button class="btn btn-sm" id="generate-retry-btn">Try again</button>
      </div>`;
  } else {
    body = `
      <div class="card" style="margin-bottom:16px">
        <p style="font-weight:600;margin-bottom:6px">Ready to generate</p>
        <p style="font-size:13px;color:var(--subtext);margin:0">Starting automatically...</p>
      </div>`;
  }

  // Continue is enabled when profile is done (regardless of discovery
  // outcome — discovery failures don't block onboarding) or when there's
  // no agent, or when generation errored (skip).
  const profileDone = generateState === 'done';
  const profileErrored = generateState === 'error';
  const discoverInFlight = discoverState === 'running';
  const canContinue = !hasAgent || (profileDone && !discoverInFlight) || profileErrored;

  let label;
  if (generateState === 'done' && discoverState === 'running') label = 'Finding companies…';
  else if (generateState === 'done') label = 'Continue';
  else if (generateState === 'error') label = 'Skip & finish';
  else if (!hasAgent) label = 'Finish without generating';
  else label = 'Waiting for agent...';

  return `
    <div class="onboarding-step active">
      <h3 class="step-title">Generating Archetypes & Narrative</h3>
      <div class="onboarding-tip">💡 This step writes your archetype table and narrative, then proposes tailored companies to track. The company URLs are health-checked before being saved.</div>
      ${body}
      <div class="step-actions">
        <button class="btn" id="back-btn" ${generateState === 'running' || discoverInFlight ? 'disabled' : ''}>← Back</button>
        <button class="btn btn-primary" id="generate-continue-btn" ${canContinue ? '' : 'disabled'}>${label}</button>
      </div>
    </div>
  `;
}

function renderScanStep() {
  const savedLimit = localStorage.getItem(SCAN_LIMIT_STORAGE_KEY) || '';

  if (scanState === 'running') {
    return `
      <div class="onboarding-step active">
        <h3 class="step-title">Initial Scan</h3>
        <div class="card" style="margin-bottom:16px">
          <div class="onboarding-status" style="display:flex">
            <span class="spinner"></span>
            <span>Scanning your tracked portals — usually about 30 seconds.</span>
          </div>
          <p style="font-size:12px;color:var(--subtext0);margin:12px 0 0 0">Hitting Greenhouse / Ashby / Lever APIs directly across the companies you enabled. Results will land in your Jobs pipeline.</p>
        </div>
      </div>
    `;
  }

  if (scanState === 'done') {
    const count = scanResultCount;
    return `
      <div class="onboarding-step active">
        <h3 class="step-title">Initial Scan</h3>
        <div class="card" style="margin-bottom:16px;border-left:3px solid var(--green)">
          <p style="font-weight:600;margin-bottom:6px">✓ ${count > 0 ? `${count} new offer${count !== 1 ? 's' : ''} added to your pipeline` : 'Scan complete'}</p>
          <p style="font-size:13px;color:var(--subtext);margin:0">${count > 0 ? 'They\'re queued under Pending in the Jobs tab.' : 'No new openings matched your filters this time. You can re-run a scan or open a Deep Scan from the Jobs page.'}</p>
        </div>
        <div class="step-actions">
          <div></div>
          <button class="btn btn-primary" id="scan-finish-btn">Finish</button>
        </div>
      </div>
    `;
  }

  if (scanState === 'error') {
    return `
      <div class="onboarding-step active">
        <h3 class="step-title">Initial Scan</h3>
        <div class="card" style="margin-bottom:16px;border-left:3px solid var(--red)">
          <p style="font-weight:600;margin-bottom:6px">Scan failed</p>
          <p style="font-size:13px;color:var(--subtext);margin:0 0 10px 0">${esc(scanError || 'Unknown error')}</p>
          <p style="font-size:12px;color:var(--subtext0);margin:0">You can retry or skip — you can always run a scan later from the Jobs page.</p>
        </div>
        <div class="step-actions">
          <button class="btn" id="scan-skip-btn">Skip — finish onboarding</button>
          <button class="btn btn-primary" id="scan-run-btn">Try again</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="onboarding-step active">
      <h3 class="step-title">Initial Scan</h3>
      <div class="onboarding-tip">💡 Want to seed your pipeline with a fresh batch of openings? This runs a quick scan against the Greenhouse / Ashby / Lever APIs of the companies you enabled. Takes about 30 seconds and doesn't use any agent credits.</div>
      <p class="step-description" style="font-size:13px;color:var(--subtext);margin-bottom:16px">Want a broader sweep that uses your agent to search outside tracked companies? <a href="#/pipeline" class="onboarding-inline-link"><strong>Deep Scan</strong></a> on the Jobs page handles that — better to run it once you've reviewed the initial results.</p>

      <div class="card" style="margin-bottom:16px">
        <p style="font-weight:600;margin-bottom:6px">Limit (optional)</p>
        <p style="font-size:13px;color:var(--subtext);margin:0 0 10px 0">Cap the number of new roles for speed. Leave blank to add everything that matches your filters.</p>
        <input class="form-input" id="scan-limit-input" type="number" min="1" max="500" placeholder="e.g. 25" value="${esc(savedLimit)}" style="width:160px">
      </div>

      <div class="step-actions">
        <button class="btn" id="scan-skip-btn">Skip — finish onboarding</button>
        <button class="btn btn-primary" id="scan-run-btn">Run scan</button>
      </div>
    </div>
  `;
}

function renderDone() {
  return `
    <div class="onboarding-step active">
      <div class="onboarding-done">
        <h2>You're all set!</h2>
        <p>Your CataBull pipeline is ready. Review your profile on the Profile tab, then start scanning portals and evaluating jobs.</p>
        <div class="done-actions">
          <button class="btn btn-primary" id="go-dashboard">Go to Dashboard</button>
        </div>
      </div>
    </div>
  `;
}

function renderStep(container) {
  const step = STEPS[currentStep];
  let html = '';
  switch (step) {
    case 'welcome': html = renderWelcome(); break;
    case 'agent': html = renderAgentStep(); break;
    case 'cv': html = renderCVStep(); break;
    case 'profile': html = renderProfileStep(); break;
    case 'portals': html = renderPortalsStep(); break;
    case 'generate': html = renderGenerateStep(); break;
    case 'scan': html = renderScanStep(); break;
    case 'done': html = renderDone(); break;
  }
  container.innerHTML = `<div class="onboarding">${html}</div>${dots()}`;
  // Each step starts fresh at the top — without this, advancing from a tall
  // step (Profile) to a shorter one (Portals) leaves the window scrolled
  // mid-page and the first card looks like it's missing.
  window.scrollTo({ top: 0 });
  bindEvents(container);
  // The Start-over link lives inside dots() so it appears on every step.
  // Bind here (not in bindEvents) since dots() is rendered outside the
  // .onboarding-step the per-step bindEvents focuses on.
  document.getElementById('onboarding-reset-btn')?.addEventListener('click', handleStartOver);
}

async function handleStartOver() {
  // Independent confirm flow that doesn't depend on candidate.full_name —
  // typical for an aborted onboarding where the name is blank or the Jane
  // Smith template default. The server accepts the literal "DELETE" as
  // bypass.
  const ok = await confirmModal({
    title: 'Start over?',
    body: `
      <p style="font-size:14px;color:var(--subtext);margin-bottom:8px">This permanently removes everything onboarding has written so far: your CV, profile, archetypes, portals, reports, outputs, applications tracker, and pipeline data.</p>
      <p style="font-size:13px;color:var(--subtext0);margin-bottom:12px">The page reloads and onboarding restarts from the beginning. This cannot be undone.</p>
      <p style="font-size:13px;color:var(--text);margin-bottom:6px">Type <strong>DELETE</strong> to confirm:</p>
      <input class="form-input" data-return="confirmName" autocomplete="off" spellcheck="false" autofocus>
    `,
    confirmText: 'Wipe & restart',
    danger: true,
  });
  if (!ok) return;
  const typed = (ok.data?.confirmName || '').trim().toUpperCase();
  if (typed !== 'DELETE') {
    toast('Type DELETE exactly to confirm.', 'error');
    return;
  }
  try {
    await api.deleteUserProfile('DELETE');
    toast('Wiped — reloading onboarding.');
    setTimeout(() => window.location.reload(), 600);
  } catch (err) {
    toast(`Reset failed: ${err.message}`, 'error');
  }
}

async function startGeneration(container) {
  generateState = 'running';
  generateError = '';
  discoverState = 'idle';
  discoverError = '';
  discoverResult = null;
  renderStep(container);
  try {
    const res = await api.onboardingGenerateProfile();
    if (res?.success) {
      generateState = 'done';
    } else {
      generateState = 'error';
      generateError = res?.error || 'Unknown error';
    }
  } catch (err) {
    generateState = 'error';
    generateError = err.message || String(err);
  }
  renderStep(container);

  // W2: profile success kicks off company discovery automatically. We
  // intentionally don't await here — the user sees the profile-done
  // card immediately and the discovery sub-block updates in place when
  // it finishes. Discovery failures don't block continuation.
  if (generateState === 'done') {
    startDiscovery(container);
  }
}

async function startDiscovery(container) {
  discoverState = 'running';
  discoverError = '';
  discoverResult = null;
  renderStep(container);
  try {
    const res = await api.onboardingDiscoverCompanies();
    if (res?.success) {
      discoverResult = res;
      discoverState = 'done';
    } else {
      discoverState = 'error';
      discoverError = res?.error || 'Unknown error';
    }
  } catch (err) {
    discoverState = 'error';
    discoverError = err.message || String(err);
  }
  renderStep(container);
}

async function refreshAgents() {
  try {
    const data = await api.terminalAgents();
    availableAgents = data.agents || [];
    supportedAgents = data.supported || supportedAgents;
    if (!selectedAgent || !availableAgents.includes(selectedAgent)) {
      selectedAgent = availableAgents[0] || '';
    }
    agentTestResult = null;
  } catch {
    availableAgents = [];
  }
}

function bindEvents(container) {
  const step = STEPS[currentStep];

  container.querySelector('#back-btn')?.addEventListener('click', () => {
    currentStep = Math.max(0, currentStep - 1);
    renderStep(container);
  });

  if (step === 'welcome') {
    container.querySelector('#start-btn').onclick = () => {
      currentStep = STEPS.indexOf('agent');
      renderStep(container);
    };
  }

  if (step === 'agent') {
    container.querySelectorAll('input[name="agent-pick"]').forEach(radio => {
      radio.onchange = () => {
        selectedAgent = radio.value;
        agentTestResult = null;
        renderStep(container);
      };
    });

    container.querySelector('#recheck-agent-btn')?.addEventListener('click', async () => {
      await refreshAgents();
      renderStep(container);
      toast(availableAgents.length ? `Detected: ${availableAgents.join(', ')}` : 'Still no agent on PATH');
    });

    container.querySelector('#test-agent-btn')?.addEventListener('click', async () => {
      if (!selectedAgent) return;
      const btn = container.querySelector('#test-agent-btn');
      btn.disabled = true;
      btn.textContent = 'Testing...';
      try {
        agentTestResult = await api.testAgent(selectedAgent);
      } catch (err) {
        agentTestResult = { ok: false, error: err.message };
      }
      renderStep(container);
      toast(agentTestResult.ok ? `${selectedAgent} works` : `${selectedAgent} test failed`, agentTestResult.ok ? undefined : 'error');
    });

    container.querySelector('#agent-continue-btn').onclick = async () => {
      if (!selectedAgent) {
        toast('Install or select a detected agent before continuing.', 'error');
        return;
      }
      if (selectedAgent) {
        // Keep the chat panel in sync with the onboarding choice. The server
        // stores this in profile.yml, but the panel also reads this browser
        // preference and otherwise can keep an older/default agent selected.
        try { localStorage.setItem('catabull-terminal-agent', selectedAgent); } catch {}
        try { await api.onboardingAgent(selectedAgent); } catch { /* non-blocking */ }
      }
      currentStep = STEPS.indexOf('cv');
      renderStep(container);
    };
  }

  if (step === 'cv') {
    const input = container.querySelector('#cv-input');
    const previewBtn = container.querySelector('#preview-cv-btn');
    const previewArea = container.querySelector('#cv-preview-area');
    const previewContent = container.querySelector('#cv-preview-content');
    const fileInput = container.querySelector('#cv-file-input');
    const fileStatus = container.querySelector('#cv-file-status');
    const saveBtn = container.querySelector('#save-cv-btn');
    const statusBar = container.querySelector('#cv-status-bar');
    const statusText = container.querySelector('#cv-status-text');

    // Gate the Save button on having some content to save.
    const refreshGate = () => { saveBtn.disabled = !input.value.trim(); };
    input.addEventListener('input', refreshGate);
    refreshGate();

    previewBtn.onclick = () => {
      previewArea.style.display = previewArea.style.display === 'none' ? 'block' : 'none';
      previewContent.innerHTML = renderMarkdown(input.value);
    };

    // Pretty section title from a filename: strip extension, replace
    // separators with spaces, title-case.
    function sectionTitleFromFilename(filename) {
      const base = String(filename || '').replace(/\.[^.]+$/, '');
      const cleaned = base.replace(/[._\-]+/g, ' ').trim();
      return cleaned
        .split(/\s+/)
        .map((w) => w ? w[0].toUpperCase() + w.slice(1) : '')
        .join(' ') || 'Document';
    }

    // Extract one file's text, returning a Markdown section. Plain-text /
    // markdown files are read directly in the browser; PDF and DOCX go
    // through the parsing route. Returns null on failure (caller logs).
    async function extractFile(file) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (['md', 'markdown', 'txt'].includes(ext)) {
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
          reader.readAsText(file);
        });
      }
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/v1/onboarding/cv-upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      return String(data.text || '');
    }

    const handleFiles = async (files) => {
      const list = Array.from(files || []).filter(Boolean);
      if (list.length === 0) return;

      // First file replaces the textarea wholesale (so the user can re-upload
      // without piling stale content on top). Subsequent files append as new
      // sections. If the user already typed/pasted into the textarea, we
      // treat that as a section too and prepend it as `## Pasted text`.
      fileStatus.textContent = list.length === 1
        ? `Parsing ${list[0].name}...`
        : `Parsing ${list.length} files...`;

      const sections = [];
      const existing = input.value.trim();
      let appendMode = false;
      if (existing) {
        // If existing content is itself the result of a prior upload (it
        // already has `## ` headers we wrote), keep it as-is. Otherwise
        // treat it as pasted text.
        if (existing.startsWith('## ')) {
          sections.push(existing);
          appendMode = true;
        } else if (list.length > 0) {
          sections.push(`## Pasted text\n\n${existing}`);
          appendMode = true;
        }
      }

      try {
        for (const file of list) {
          const text = await extractFile(file);
          const cleaned = text.trim();
          if (!cleaned) continue;
          // If the file is a single-section doc with no leading header, give
          // it one derived from the filename. If it already starts with `# ` or
          // `## `, preserve as-is.
          const hasHeader = /^#{1,6}\s/.test(cleaned);
          const section = hasHeader ? cleaned : `## ${sectionTitleFromFilename(file.name)}\n\n${cleaned}`;
          sections.push(section);
        }

        if (sections.length === 0) {
          fileStatus.textContent = '';
          toast('No readable content extracted from selected file(s).', 'error');
          return;
        }

        input.value = sections.join('\n\n');
        const totalChars = input.value.length.toLocaleString();
        fileStatus.textContent = list.length === 1
          ? `Extracted ${list[0].name} (${totalChars} chars). Click Save & Continue.`
          : `Extracted ${list.length} files (${totalChars} chars total). Click Save & Continue.`;
        refreshGate();
      } catch (err) {
        fileStatus.textContent = '';
        toast(`Upload failed: ${err.message}`, 'error');
      }
    };

    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
    input.addEventListener('dragover', e => { e.preventDefault(); input.style.borderColor = 'var(--blue)'; });
    input.addEventListener('dragleave', () => { input.style.borderColor = ''; });
    input.addEventListener('drop', e => {
      e.preventDefault();
      input.style.borderColor = '';
      handleFiles(e.dataTransfer.files);
    });

    const dropzone = container.querySelector('#cv-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
      dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('dragover'); });
      dropzone.addEventListener('drop', e => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
      });
    }

    saveBtn.onclick = async () => {
      const cvBody = input.value.trim();
      if (!cvBody) return;

      // Append the optional notes textarea as its own ## Notes section so the
      // profile-generation prompt can read it alongside the rest of the CV.
      // Empty notes are dropped silently.
      const notesEl = container.querySelector('#cv-notes-input');
      const notes = (notesEl?.value || '').trim();
      const content = notes
        ? `${cvBody}\n\n## Notes & additional context\n\n${notes}`
        : cvBody;

      const agent = selectedAgent || availableAgents[0] || '';
      const hasAgent = availableAgents.length > 0;

      // Lock the UI while analyzing.
      saveBtn.disabled = true;
      const backBtn = container.querySelector('#back-btn');
      const previewBtn2 = container.querySelector('#preview-cv-btn');
      const skipAiBtn = container.querySelector('#cv-skip-ai-btn');
      backBtn.disabled = true;
      previewBtn2.disabled = true;
      input.disabled = true;
      fileInput.disabled = true;

      statusBar.style.display = 'flex';
      statusText.textContent = hasAgent
        ? `Analyzing and cleaning CV with ${agent}... (this takes 20-60s)`
        : 'Saving raw CV (no agent for analysis)...';
      // Skip button is only useful when analysis is actually running.
      skipAiBtn.style.display = hasAgent ? '' : 'none';

      const unlock = () => {
        saveBtn.disabled = false;
        backBtn.disabled = false;
        previewBtn2.disabled = false;
        input.disabled = false;
        fileInput.disabled = false;
        statusBar.style.display = 'none';
      };

      // Abortable fetch so the "Skip — save raw" button can bail out of
      // a hung analyze call without waiting for the 3-minute server timeout.
      const abortCtl = new AbortController();
      let userSkipped = false;
      skipAiBtn.onclick = async () => {
        userSkipped = true;
        skipAiBtn.disabled = true;
        statusText.textContent = 'Saving CV as-is...';
        abortCtl.abort();
        try { await api.onboardingCV(content); } catch { /* raw was already saved server-side on analyze; ignore */ }
        status.cv = true;
        toast('CV saved without AI analysis. Fill in the next step manually.');
        currentStep = STEPS.indexOf('profile');
        renderStep(container);
      };

      try {
        const res = await api.onboardingCvAnalyze(content, { signal: abortCtl.signal });
        status.cv = true;

        if (res?.success && res.profile) {
          // Populate next-step fields from the LLM output. User-entered
          // values (from hitting Back) always win.
          const pick = (prev, ai) => (prev !== undefined && prev !== '' && !(Array.isArray(prev) && prev.length === 0)) ? prev : ai;
          const prevCand = profileData.candidate || {};
          const prevNar = profileData.narrative || {};
          const prevRoles = profileData.target_roles?.primary || [];
          const prevKeywords = profileData.target_roles?.title_keywords || [];
          const p = res.profile;

          profileData = {
            ...profileData,
            candidate: {
              full_name: pick(prevCand.full_name, p.full_name || ''),
              email: pick(prevCand.email, p.email || ''),
              phone: pick(prevCand.phone, p.phone || ''),
              location: pick(prevCand.location, p.location || ''),
              linkedin: pick(prevCand.linkedin, p.linkedin || ''),
              github: pick(prevCand.github, p.github || ''),
              portfolio_url: pick(prevCand.portfolio_url, p.portfolio_url || ''),
            },
            narrative: {
              ...prevNar,
              headline: pick(prevNar.headline, p.headline || ''),
              superpowers: pick(prevNar.superpowers, p.superpowers || []),
            },
            target_roles: {
              ...(profileData.target_roles || {}),
              primary: prevRoles.length ? prevRoles : (Array.isArray(p.target_roles) ? p.target_roles : []),
              title_keywords: prevKeywords.length ? prevKeywords : (Array.isArray(p.title_keywords) ? p.title_keywords : []),
              inferred_industries: Array.isArray(p.inferred_industries) ? p.inferred_industries : [],
            },
          };
          if (!selectedIndustries.length && Array.isArray(p.inferred_industries) && p.inferred_industries.length) {
            selectedIndustries = p.inferred_industries;
          }
          const filled = Object.values(profileData.candidate).filter(Boolean).length;
          toast(`AI analyzed CV and pre-filled ${filled} field${filled !== 1 ? 's' : ''}`);
        } else {
          toast('CV saved as-is (no agent analysis)');
        }

        currentStep = STEPS.indexOf('profile');
        renderStep(container);
      } catch (err) {
        // The skip button handles its own transition; don't double-fire here.
        if (userSkipped) return;
        unlock();
        // The server falls back to saving raw text even on LLM failure,
        // so treat this as "CV is saved but extraction failed" and let
        // the user continue manually.
        status.cv = true;
        toast(`AI analysis failed: ${err.message}. CV saved raw — fill next step manually.`, 'error');
        currentStep = STEPS.indexOf('profile');
        renderStep(container);
      }
    };
  }

  if (step === 'profile') {
    // Gate Save on name + email + at least one primary role.
    const saveProfileBtn = container.querySelector('#save-profile-btn');
    const refreshProfileGate = () => {
      const name = container.querySelector('#p-name').value.trim();
      const email = container.querySelector('#p-email').value.trim();
      const roles = container.querySelector('#p-roles').value.trim();
      saveProfileBtn.disabled = !(name && email && roles);
    };
    ['#p-name', '#p-email', '#p-roles'].forEach(sel => {
      container.querySelector(sel).addEventListener('input', refreshProfileGate);
    });
    refreshProfileGate();

    saveProfileBtn.onclick = async () => {
      const get = (id) => container.querySelector(id).value.trim();
      const data = {
        candidate: {
          full_name: get('#p-name'),
          email: get('#p-email'),
          phone: get('#p-phone'),
          location: get('#p-location'),
          linkedin: get('#p-linkedin'),
          github: get('#p-github'),
          portfolio_url: get('#p-portfolio'),
        },
        target_industries: profileData.target_industries || selectedIndustries,
        target_roles: {
          primary: get('#p-roles').split('\n').map(s => s.trim()).filter(Boolean),
          title_keywords: profileData.target_roles?.title_keywords || [],
          inferred_industries: profileData.target_roles?.inferred_industries || [],
        },
        narrative: {
          headline: get('#p-headline'),
          exit_story: get('#p-exit'),
        },
        compensation: {
          target_range: get('#p-salary'),
          minimum: get('#p-min-salary'),
          location_flexibility: get('#p-loc-flex'),
          currency: 'USD',
        },
        location: {
          country: get('#p-country'),
          timezone: get('#p-timezone'),
          visa_status: get('#p-visa'),
        },
      };
      try {
        await api.onboardingProfile(data);
        await api.onboardingTracker();
        status.profile = true;
        status.profileMd = true;
        status.tracker = true;
        profileData = { ...profileData, ...data };
        portalTitleKeywords = null;
        toast('Profile saved');
        currentStep = STEPS.indexOf('portals');
        renderStep(container);
      } catch { toast('Failed to save profile', 'error'); }
    };
  }

  if (step === 'portals') {
    const setupBtn = container.querySelector('#setup-portals-btn');
    const keywordsInput = container.querySelector('#portal-keywords');
    const refreshPortalsGate = () => {
      const checked = container.querySelectorAll('.site-pill.selected').length;
      const industries = container.querySelectorAll('.industry-pill.selected').length;
      const keywords = normalizeLines(keywordsInput?.value || '');
      setupBtn.disabled = checked === 0 || industries === 0 || keywords.length === 0;
    };
    keywordsInput?.addEventListener('input', () => {
      portalTitleKeywords = normalizeLines(keywordsInput.value);
      refreshPortalsGate();
    });

    const togglePill = (btn) => {
      const isSelected = btn.classList.toggle('selected');
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    };

    container.querySelectorAll('.site-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        togglePill(btn);
        refreshPortalsGate();
      });
    });
    container.querySelectorAll('.industry-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        togglePill(btn);
        selectedIndustries = [...container.querySelectorAll('.industry-pill.selected')].map(b => b.dataset.industry);
        refreshPortalsGate();
      });
    });
    refreshPortalsGate();

    setupBtn.onclick = async () => {
      const sites = [...container.querySelectorAll('.site-pill.selected')].map(b => b.dataset.site);
      const industries = [...container.querySelectorAll('.industry-pill.selected')].map(b => b.dataset.industry);
      const keywords = normalizeLines(keywordsInput?.value || '');
      selectedIndustries = industries;
      portalTitleKeywords = keywords;
      setupBtn.disabled = true;
      setupBtn.textContent = 'Configuring...';
      try {
        const settingsPayload = {
          braveApiKey: container.querySelector('#portal-brave-key')?.value?.trim() || '',
          serperApiKey: container.querySelector('#portal-serper-key')?.value?.trim() || '',
        };
        if (settingsData) {
          settingsPayload.webSearchProvider = container.querySelector('#portal-web-search-provider')?.value || 'auto';
          settingsPayload.webSearchOrder = container.querySelector('#portal-web-search-order')?.value || 'brave,serper,scrape';
        }
        if (settingsData || settingsPayload.braveApiKey || settingsPayload.serperApiKey) {
          const settingsResult = await api.updateSettings(settingsPayload);
          if (settingsResult?.settings) settingsData = settingsResult.settings;
        }
        await api.onboardingPortals({ sites, industries, customFilters: { positive: keywords } });
        status.portals = true;
        profileData = {
          ...profileData,
          target_roles: {
            ...(profileData.target_roles || {}),
            title_keywords: keywords,
          },
        };
        toast(`Portals configured (${sites.length} source${sites.length !== 1 ? 's' : ''})`);
        currentStep = STEPS.indexOf('generate');
        renderStep(container);
        // Kick off generation automatically if we have an agent. Used to
        // happen after the GitHub step; now happens straight from Portals.
        if (availableAgents.length > 0 && generateState === 'idle') {
          startGeneration(container);
        }
      } catch (err) {
        setupBtn.disabled = false;
        setupBtn.textContent = 'Set Up Portals & Continue';
        toast(`Failed to set up portals or provider settings: ${err.message || 'unknown error'}`, 'error');
      }
    };
  }

  if (step === 'generate') {
    container.querySelector('#generate-retry-btn')?.addEventListener('click', () => startGeneration(container));
    container.querySelector('#generate-continue-btn').onclick = () => {
      // Reset state so a fresh run on this same step (re-entering after
      // going back) behaves cleanly.
      generateState = 'idle';
      generateError = '';
      discoverState = 'idle';
      discoverError = '';
      discoverResult = null;
      currentStep = STEPS.indexOf('scan');
      renderStep(container);
    };
  }

  if (step === 'scan') {
    const limitInput = container.querySelector('#scan-limit-input');
    const skipBtn = container.querySelector('#scan-skip-btn');
    const runBtn = container.querySelector('#scan-run-btn');
    const finishBtn = container.querySelector('#scan-finish-btn');

    skipBtn?.addEventListener('click', () => {
      scanState = 'skipped';
      currentStep = STEPS.indexOf('done');
      renderStep(container);
    });

    runBtn?.addEventListener('click', async () => {
      const raw = limitInput?.value?.trim() || '';
      const parsed = raw ? Math.max(1, Math.min(500, parseInt(raw, 10) || 0)) : 0;
      if (parsed > 0) localStorage.setItem(SCAN_LIMIT_STORAGE_KEY, String(parsed));
      else localStorage.removeItem(SCAN_LIMIT_STORAGE_KEY);

      scanState = 'running';
      scanError = '';
      renderStep(container);
      // Quick API scan, not the agent-driven Deep Scan. The chat drawer
      // isn't initialized during onboarding (the dashboard container is
      // hidden), so a runModePrompt('scan') would queue a prompt against
      // an invisible drawer and the user would see nothing happen.
      try {
        const result = await api.runScanNow(parsed);
        if (result?.success) {
          scanResultCount = Number(result.newOffers) || 0;
          scanState = 'done';
        } else {
          scanState = 'error';
          scanError = result?.error || 'Scan returned no result.';
        }
      } catch (err) {
        scanState = 'error';
        scanError = err?.message || String(err);
      }
      renderStep(container);
    });

    finishBtn?.addEventListener('click', () => {
      currentStep = STEPS.indexOf('done');
      renderStep(container);
    });
  }

  if (step === 'done') {
    container.querySelector('#go-dashboard').onclick = () => {
      // Land on Discover (PR 1.3) so a fresh user sees real roles
      // (sorted by fit, with rationale) before any config screens.
      // Forcing the hash overrides any earlier navigation that left
      // a different view selected.
      window.location.hash = '#/discover';
      window.location.reload();
    };
  }
}

export async function render(container) {
  try {
    const data = await api.onboardingStatus();
    status = data.steps;
    try {
      const profData = await api.getProfile();
      if (profData.profile) {
        profileData = profData.profile;
        if (Array.isArray(profileData.target_industries)) selectedIndustries = profileData.target_industries;
      }
    } catch { /* ok */ }
    try {
      settingsData = await api.getSettings();
    } catch {
      settingsData = null;
    }
  } catch {
    status = { cv: false, profile: false, profileMd: false, portals: false, tracker: false };
  }

  await refreshAgents();

  currentStep = 0;
  renderStep(container);
}
