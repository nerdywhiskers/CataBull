// Markdown is rendered into innerHTML in several views (reports, profile,
// chat, onboarding, analytics). Anything Markdown-shaped that reaches a
// caller — agent output, job descriptions, CV text, profile notes — is
// untrusted: a malicious posting could embed `<script>` or `<img onerror>`
// inside an otherwise-innocent report. Run every render through DOMPurify
// so the output going into innerHTML is HTML-safe even if marked passed
// raw HTML through.
//
// Allowlist is conservative: standard Markdown formatting + safe link
// targets. We strip on* attributes, javascript: and data: URLs, <script>,
// <iframe>, etc. by default (DOMPurify does this with no extra config).

const SANITIZE_OPTS = {
  ALLOWED_TAGS: [
    'p', 'br', 'span', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'mark',
    'ul', 'ol', 'li',
    'a',
    'blockquote', 'hr',
    'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  RETURN_TRUSTED_TYPE: false,
};

function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(raw) {
  const text = String(raw ?? '');
  // marked + DOMPurify are loaded as <script> tags from /vendor/. If
  // either failed to load, escape and line-break — never return raw
  // text that would be interpreted as HTML.
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return escape(text).replace(/\n/g, '<br>');
  }
  const html = marked.parse(text);
  return DOMPurify.sanitize(html, SANITIZE_OPTS);
}
