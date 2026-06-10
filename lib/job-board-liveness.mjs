const BLOCKED_BOARD_HOSTS = [
  { host: 'theladders.com', label: 'TheLadders' },
];

const BLOCKED_BOARD_BARRIER_RE = /(HTTP\s*403|cloudflare|captcha|security verification|bot challenge|access denied|forbidden|transport\/interstitial|barrier:|barrier detected)/i;

function hostnameFor(url = '') {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function blockedBoardFor(url = '') {
  const host = hostnameFor(url);
  if (!host) return null;
  return BLOCKED_BOARD_HOSTS.find((board) => host === board.host || host.endsWith(`.${board.host}`)) || null;
}

export function normalizeJobBoardLiveness(url, result) {
  if (!result || result.result !== 'uncertain') return result;
  const board = blockedBoardFor(url);
  if (!board) return result;
  const reason = String(result.reason || '');
  if (!BLOCKED_BOARD_BARRIER_RE.test(reason)) return result;
  return {
    result: 'expired',
    reason: `${board.label} blocked verification (${reason}); treating as unavailable`,
  };
}

export function isActiveLiveness(result) {
  return result?.result === 'active';
}
