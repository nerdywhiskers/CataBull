/**
 * lib/title-filter.mjs — Job title positive/negative keyword filtering.
 *
 * Shared between scan.mjs and lib/discovery.mjs (W7 role-fit pre-flight).
 * Pulled out of scan.mjs as part of PR 1.1 so the verified-discovery
 * orchestrator can reuse the same matching logic without duplication.
 */

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a Unicode-aware word-boundary matcher for a keyword.
 *
 * ASCII `\b` doesn't work for German letters (ü, ä) or non-letter starts
 * (.NET, C++), so we use lookbehind/lookahead on Unicode letter+number
 * classes. Anchors only kick in where the keyword actually starts/ends
 * with a letter or digit, so ".NET" still matches ".NET Engineer".
 */
export function buildKeywordPattern(rawKeyword) {
  const keyword = String(rawKeyword || '').trim();
  if (!keyword) return null;
  const startsWithWordChar = /^[\p{L}\p{N}]/u.test(keyword);
  const endsWithWordChar = /[\p{L}\p{N}]$/u.test(keyword);
  const before = startsWithWordChar ? '(?<![\\p{L}\\p{N}])' : '';
  const after = endsWithWordChar ? '(?![\\p{L}\\p{N}])' : '';
  try {
    return new RegExp(`${before}${escapeRegex(keyword)}${after}`, 'iu');
  } catch {
    return null;
  }
}

function buildTokenPattern(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  const startsWithWordChar = /^[\p{L}\p{N}]/u.test(token);
  const endsWithWordChar = /[\p{L}\p{N}]$/u.test(token);
  const before = startsWithWordChar ? '(?<![\\p{L}\\p{N}])' : '';
  const after = endsWithWordChar ? '(?![\\p{L}\\p{N}])' : '';
  return `${before}${escapeRegex(token)}${after}`;
}

const REVIEW_STOPWORDS = new Set([
  'senior', 'staff', 'principal', 'lead', 'head', 'director', 'manager',
  'junior', 'intern', 'assistant', 'associate', 'of', 'and', 'the',
  // Single tokens that are too broad to safely promote to review matches.
  // Their full phrases still match as strong positives, e.g. "Technical Art
  // Director" or "Creative Director".
  'technical', 'tech', 'art', 'creative', 'gen', 'generative', 'ai', 'product',
]);

const DEFAULT_REVIEW_NEGATIVE = [
  'Technical Support',
  'Support Engineer',
  'Support Specialist',
  'Support Representative',
  'Technical Account',
  'Account Manager',
  'Customer Support',
  'Customer Success',
  'Customer Experience',
  'Sales',
  'Solutions Manager',
  'Solutions Architect',
  'Technical Accounting',
  'Technical Revenue',
  'Revenue Accountant',
  'Financial Reporting',
  'Recruiter',
  'Sourcer',
  'Talent Acquisition',
  'Program Manager',
  'Project Manager',
  'Product Manager',
  'Operations',
  'Content Writer',
  'Technical Writer',
  'Documentation',
  'Enablement',
  'Evangelist',
  'Advocate Engineer',
  'Designer Advocate',
  'Quality Assurance',
  'QA',
  'Tattoo Artist',
  'Makeup Artist',
  'Drug Designer',
  'Computational Drug Designer',
];

export function buildFlexibleKeywordPattern(rawKeyword) {
  const keyword = String(rawKeyword || '').trim();
  if (!keyword) return null;
  const tokens = keyword.match(/[\p{L}\p{N}.+#]+/gu) || [];
  const unique = [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
  if (unique.length < 2) return null;
  try {
    return new RegExp(unique.map((token) => `(?=.*${buildTokenPattern(token)})`).join('') + '.*', 'iu');
  } catch {
    return null;
  }
}

function inferReviewKeywords(titleFilter) {
  const configured = Array.isArray(titleFilter?.review) ? titleFilter.review : [];
  const seniority = new Set((titleFilter?.seniority_boost || []).map((s) => String(s || '').toLowerCase()));
  const inferred = [];
  for (const keyword of titleFilter?.positive || []) {
    const tokens = String(keyword || '').match(/[\p{L}\p{N}.+#]+/gu) || [];
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower.length < 3) continue;
      if (REVIEW_STOPWORDS.has(lower) || seniority.has(lower)) continue;
      inferred.push(token);
    }
  }
  return [...new Set([...configured, ...inferred])];
}

export function buildTitleClassifier(titleFilter) {
  const positive = (titleFilter?.positive || [])
    .flatMap((keyword) => [buildKeywordPattern(keyword), buildFlexibleKeywordPattern(keyword)])
    .filter(Boolean);
  const negative = (titleFilter?.negative || []).map(buildKeywordPattern).filter(Boolean);
  const review = inferReviewKeywords(titleFilter).map(buildKeywordPattern).filter(Boolean);
  const reviewNegative = [
    ...DEFAULT_REVIEW_NEGATIVE,
    ...(Array.isArray(titleFilter?.review_negative) ? titleFilter.review_negative : []),
  ].map(buildKeywordPattern).filter(Boolean);

  return (title) => {
    if (!title) return { decision: 'skip', tier: 'skip', reason: 'empty title' };
    const hasNegative = negative.some((re) => re.test(title));
    if (hasNegative) return { decision: 'skip', tier: 'skip', reason: 'negative keyword' };
    const hasStrong = positive.length === 0 || positive.some((re) => re.test(title));
    if (hasStrong) return { decision: 'strong', tier: 'strong', reason: 'positive keyword' };
    const hasReview = review.some((re) => re.test(title));
    if (hasReview && reviewNegative.some((re) => re.test(title))) {
      return { decision: 'skip', tier: 'skip', reason: 'review negative keyword' };
    }
    if (hasReview) return { decision: 'review', tier: 'review', reason: 'review keyword' };
    return { decision: 'skip', tier: 'skip', reason: 'no matching keyword' };
  };
}

/**
 * Build a predicate that returns true when a title passes the filter:
 *   - matches at least one positive pattern (or no positives are configured)
 *   - matches none of the negative patterns
 *
 * Accepts the same `{ positive, negative }` shape as `portals.yml > title_filter`.
 */
export function buildTitleFilter(titleFilter) {
  const classify = buildTitleClassifier(titleFilter);
  return (title) => classify(title).decision !== 'skip';
}
