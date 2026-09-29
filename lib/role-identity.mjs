const COMPANY_SUFFIX_RE = /(?:\s+(?:(?:and\s+)?(?:inc|llc|ltd|corp|corporation|company|co|group|holdings?)))+$/;
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'src', 'source', 'ref', 'referrer', 'fbclid', 'gclid', 'mc_cid', 'mc_eid',
  'gh_src', 'gh_jid', 'lever-source',
]);
const ROLE_FILLER = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'the', 'to']);

function preserveTechnicalTokens(value) {
  return String(value || '')
    .replace(/(^|[^a-z0-9])c\+\+(?=$|[^a-z0-9])/gi, '$1cplusplus')
    .replace(/(^|[^a-z0-9])c#(?=$|[^a-z0-9])/gi, '$1csharp')
    .replace(/(^|[^a-z0-9])\.net(?=$|[^a-z0-9])/gi, '$1dotnet');
}

export function canonicalCompanyName(company) {
  return preserveTechnicalTokens(company)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalRoleName(role) {
  return preserveTechnicalTokens(role)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalCompanyRoleKey(company, role) {
  return `${canonicalCompanyName(company)}||${canonicalRoleName(role)}`;
}

/** Stable posting identity for URL variants emitted by common job providers. */
export function canonicalJobUrlKey(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    const linkedIn = path.match(/^\/(?:comm\/)?jobs\/view\/(\d+)/i);
    if (host === 'linkedin.com' && linkedIn) return `linkedin:${linkedIn[1]}`;

    const greenhouse = path.match(/\/jobs\/(\d+)(?:\/|$)/i);
    const greenhouseId = greenhouse?.[1] || url.searchParams.get('gh_jid');
    if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') && greenhouseId) {
      return `greenhouse:${greenhouseId}`;
    }

    const lever = path.match(/\/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
    if (/^(?:jobs\.)?(?:eu\.)?lever\.co$/.test(host) && lever) return `lever:${lever[1].toLowerCase()}`;

    const ashby = path.match(/\/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
    if (host === 'jobs.ashbyhq.com' && ashby) return `ashby:${ashby[1].toLowerCase()}`;

    const kept = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
      .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
    const query = new URLSearchParams(kept).toString();
    return `https://${host}${path}${query ? `?${query}` : ''}`;
  } catch {
    return input.toLowerCase().replace(/\/+$/, '');
  }
}

function providerHost(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function roleTokens(role) {
  return canonicalRoleName(role).split(' ').filter((token) => token && !ROLE_FILLER.has(token));
}

function rolesAreNearMatches(a, b) {
  const canonicalA = canonicalRoleName(a);
  const canonicalB = canonicalRoleName(b);
  if (!canonicalA || !canonicalB) return false;
  if (canonicalA === canonicalB) return true;

  const tokensA = roleTokens(a);
  const tokensB = roleTokens(b);
  const shorter = tokensA.length <= tokensB.length ? tokensA : tokensB;
  const longer = shorter === tokensA ? tokensB : tokensA;
  if (shorter.length < 3) return false;
  const overlap = shorter.filter((token) => longer.includes(token)).length;
  return overlap / shorter.length >= 0.8 && overlap / longer.length >= 0.5;
}

/**
 * Conservative duplicate predicate. Exact canonical URLs always win. Fuzzy
 * title matching is allowed only across different providers (or legacy rows
 * with a missing URL), which avoids collapsing similar roles on one board.
 */
export function sameJobPosting(a = {}, b = {}) {
  const urlA = a.url || a.jobUrl || '';
  const urlB = b.url || b.jobUrl || '';
  const keyA = canonicalJobUrlKey(urlA);
  const keyB = canonicalJobUrlKey(urlB);
  if (keyA && keyB && keyA === keyB) return true;
  if (canonicalCompanyName(a.company) !== canonicalCompanyName(b.company)) return false;
  if (!rolesAreNearMatches(a.role, b.role)) return false;
  const hostA = providerHost(urlA);
  const hostB = providerHost(urlB);
  return !hostA || !hostB || hostA !== hostB;
}
