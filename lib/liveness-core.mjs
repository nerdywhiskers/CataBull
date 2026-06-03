const HARD_EXPIRED_PATTERNS = [
  /no longer accept\w*\s+(applications?|candidates?)/i,
  /no longer open/i,
  /position has been filled/i,
  /posting has expired/i,
  /job posting has expired/i,
  /(job|posting|position) (is )?no longer available/i,
  /job (listing )?not found/i,
  /the page you are looking for (doesn.t|does not) exist/i,
  /page not found/i,
  /404 not found/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

function combineTextSnippets(snippets = []) {
  return snippets.filter(Boolean).join('\n');
}

export function classifyLiveness({
  status = 0,
  finalUrl = '',
  bodyText = '',
  titleText = '',
  extraText = '',
  applyControls = [],
} = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `HTTP ${status}` };
  }

  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
    return { result: 'uncertain', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const searchableText = combineTextSnippets([bodyText, titleText, extraText]);

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, searchableText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'uncertain', reason: 'insufficient content to verify posting state' };
  }

  return { result: 'uncertain', reason: 'content present but no explicit closed signal or visible apply control found' };
}
