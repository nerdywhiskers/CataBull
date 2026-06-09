import { classifyLiveness } from './liveness-core.mjs';

export function extractLinkedInJobId(url = '') {
  const text = String(url || '');
  if (!/linkedin\.com\/(?:comm\/)?jobs\/view\//i.test(text)) return '';
  const match = text.match(/(?:-|\/)(\d{6,})(?:[/?#]|$)/);
  return match?.[1] || '';
}

export function linkedInGuestPostingUrl(jobId) {
  return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(jobId)}`;
}

function htmlToText(html = '') {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyLinkedInGuestHtml({ status = 0, html = '', guestUrl = '' } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', reason: `LinkedIn guest API HTTP ${status}` };
  }
  if (status < 200 || status >= 300) return null;
  const text = htmlToText(html);
  if (!text) return null;
  const classified = classifyLiveness({
    status,
    finalUrl: guestUrl,
    bodyText: text,
    titleText: '',
    applyControls: [],
  });
  if (classified.result !== 'expired') return null;
  return {
    result: 'expired',
    reason: `LinkedIn guest API: ${classified.reason}`,
  };
}

export async function checkLinkedInGuestPosting(url, { fetchImpl = globalThis.fetch } = {}) {
  const jobId = extractLinkedInJobId(url);
  if (!jobId || typeof fetchImpl !== 'function') return null;
  const guestUrl = linkedInGuestPostingUrl(jobId);
  try {
    const response = await fetchImpl(guestUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 CataBull liveness checker',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    const html = await response.text();
    return classifyLinkedInGuestHtml({ status: response.status, html, guestUrl });
  } catch {
    return null;
  }
}
