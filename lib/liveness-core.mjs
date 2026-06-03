const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  /offre (expirée|n'est plus disponible)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
];

const ACCESS_WALL_URL_PATTERNS = [
  /linkedin\.com\/uas\/login/i,
  /\/login(?:[/?#]|$)/i,
  /\/signin(?:[/?#]|$)/i,
  /\/checkpoint(?:[/?#]|$)/i,
];

const ACCESS_WALL_TEXT_PATTERNS = [
  /\bsign in\b/i,
  /\blog in\b/i,
  /continue with google/i,
  /sign in with apple/i,
  /keep me logged in/i,
  /forgot password/i,
  /performing security verification/i,
  /verify you are not a bot/i,
  /security service to protect against malicious bots/i,
  /cloudflare/i,
  /captcha/i,
  /datadome/i,
  /just a moment/i,
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

  if (status === 401 || status === 408 || status === 429 || status >= 500) {
    return { result: 'uncertain', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', reason: `redirect to ${finalUrl}` };
  }

  const accessWallUrl = firstMatch(ACCESS_WALL_URL_PATTERNS, finalUrl);
  if (accessWallUrl) {
    return { result: 'expired', reason: `access wall redirect: ${finalUrl}` };
  }

  const searchableText = combineTextSnippets([bodyText, titleText, extraText]);

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, searchableText);
  if (expiredBody) {
    return { result: 'expired', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', reason: 'visible apply control detected' };
  }

  const accessWall = firstMatch(ACCESS_WALL_TEXT_PATTERNS, searchableText);
  if (accessWall) {
    return { result: 'expired', reason: `pattern matched: ${accessWall.source}` };
  }

  if (status === 403) {
    return { result: 'uncertain', reason: 'HTTP 403' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, searchableText);
  if (listingPage) {
    return { result: 'expired', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', reason: 'content present but no visible apply control found' };
}
