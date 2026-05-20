/**
 * lib/relevance.mjs — Lightweight relevance scoring for un-evaluated postings.
 *
 * Purely heuristic — keyword + archetype + seniority signals, no LLM tokens.
 * Produces a 0–5 score plus a structured rationale so the UI can show the
 * user *why* a posting got its score, not just the number.
 *
 * Used by:
 *   - dashboard-web/routes/applications.mjs (Pipeline tab pending list)
 *   - lib/discovery.mjs (could pre-score role-fit samples in the future)
 *   - dashboard-web/routes/discover.mjs (PR 1.3 — Discover tab) when added
 *
 * Evaluated applications keep their full A–E rubric score (parsed from the
 * report). This helper is for the *un-evaluated* postings where running the
 * full eval mode would be wasteful.
 */

const EXCELLENT = 4.5;
const GOOD = 4.0;
const DECENT = 3.5;
const LOW = 3.0;
export const DEFAULT_MIN_RELEVANCE = 2.5;

/**
 * Score class label. Mirrors the dashboard's visual scoreClass() so the
 * server can ship the class name directly when convenient.
 */
export function scoreClass(score) {
  if (!Number.isFinite(score)) return 'unknown';
  if (score >= EXCELLENT) return 'excellent';
  if (score >= GOOD) return 'good';
  if (score >= DECENT) return 'decent';
  if (score >= LOW) return 'low';
  return 'poor';
}

function lower(s) {
  return String(s || '').toLowerCase().trim();
}

function asLowerArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(lower).filter(Boolean);
}

/**
 * Normalize archetype entries — they can be strings (onboarding-generated)
 * or objects with `.name` (profile.example.yml format). Lowercased.
 */
export function normalizeArchetypes(archetypes) {
  if (!Array.isArray(archetypes)) return [];
  return archetypes
    .map((a) => (typeof a === 'string' ? a : a?.name) || '')
    .filter(Boolean)
    .map(lower);
}

export function hasRelevanceSignals(inputs = {}) {
  return asLowerArray(inputs.targetRoles).length > 0
    || normalizeArchetypes(inputs.archetypes).length > 0
    || asLowerArray(inputs.positiveKeywords).length > 0
    || asLowerArray(inputs.seniorityBoost).length > 0;
}

export function resolveMinRelevance(value, fallback = DEFAULT_MIN_RELEVANCE) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(5, parsed));
}

/**
 * Score how well a posting title matches the user's target. Pure function.
 *
 * Returns { score, factors }:
 *   score: 0..5 with one decimal
 *   factors: [{ label, delta }] — list of contributors so the UI can build
 *     a "Matched archetype +1.5; matched 'Engineer' +0.5" tooltip.
 *
 * `inputs` shape (any field optional; gracefully handles missing data):
 *   {
 *     targetRoles: string[],         // profile.target_roles.primary
 *     archetypes:  string[]|object[],// profile.target_roles.archetypes
 *     positiveKeywords: string[],    // portals.title_filter.positive
 *     seniorityBoost:  string[],     // portals.title_filter.seniority_boost
 *   }
 */
export function scorePostingTitle(title, inputs = {}) {
  const t = lower(title);
  if (!t) {
    return { score: 0, factors: [{ label: 'No title', delta: 0 }] };
  }

  const targetRoles = asLowerArray(inputs.targetRoles);
  const archetypes = normalizeArchetypes(inputs.archetypes);
  const positiveKeywords = asLowerArray(inputs.positiveKeywords);
  const seniorityBoost = asLowerArray(inputs.seniorityBoost);

  const factors = [];
  let raw = 0;

  // Primary target role match — strongest signal (+2.0).
  const roleHit = targetRoles.find((r) => t.includes(r) || r.includes(t));
  if (roleHit) {
    raw += 2;
    factors.push({ label: `Matches target role "${roleHit}"`, delta: 2.0 });
  }

  // Archetype match (+1.5).
  const archHit = archetypes.find((a) => t.includes(a) || a.includes(t));
  if (archHit) {
    raw += 1.5;
    factors.push({ label: `Matches archetype "${archHit}"`, delta: 1.5 });
  }

  // Positive keyword hits (+0.5 each, capped at +2.0).
  const matchedKeywords = positiveKeywords.filter((k) => t.includes(k));
  if (matchedKeywords.length > 0) {
    const keywordDelta = Math.min(matchedKeywords.length * 0.5, 2);
    raw += keywordDelta;
    factors.push({
      label: `Title keywords: ${matchedKeywords.slice(0, 3).join(', ')}${matchedKeywords.length > 3 ? '…' : ''}`,
      delta: keywordDelta,
    });
  }

  // Seniority boost (+0.5).
  const seniorityHit = seniorityBoost.find((s) => t.includes(s));
  if (seniorityHit) {
    raw += 0.5;
    factors.push({ label: `Seniority signal "${seniorityHit}"`, delta: 0.5 });
  }

  // Junior / Associate / Intern penalties.
  if (/\bassociate\b/i.test(t) || /\bjunior\b/i.test(t)) {
    raw -= 1;
    factors.push({ label: 'Junior/Associate signal', delta: -1.0 });
  }
  if (/\bintern\b/i.test(t)) {
    raw -= 2;
    factors.push({ label: 'Intern signal', delta: -2.0 });
  }

  const score = Math.max(0, Math.min(5, Math.round(raw * 10) / 10));
  if (factors.length === 0) {
    factors.push({ label: 'No matching signals', delta: 0 });
  }
  return { score, factors };
}

/**
 * Build a one-line summary from a factors[] list. Format the dashboard
 * uses for tooltips: "Matches target role 'engineer' (+2.0); seniority +0.5".
 *
 * Pure function so the same string can render server-side or client-side.
 */
export function rationaleSummary(factors, { max = 3 } = {}) {
  if (!Array.isArray(factors) || factors.length === 0) return '';
  const ordered = [...factors].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const head = ordered.slice(0, max).map((f) => {
    if (!f.delta) return f.label;
    const sign = f.delta > 0 ? '+' : '';
    return `${f.label} (${sign}${f.delta.toFixed(1)})`;
  });
  return head.join('; ');
}

/**
 * Convenience: build the relevance inputs from a parsed profile + portals
 * pair. Centralizes the field paths so individual call sites don't have
 * to know about archetypes-as-strings-vs-objects, etc.
 */
export function relevanceInputsFrom({ profile, portals } = {}) {
  return {
    targetRoles: profile?.target_roles?.primary || [],
    archetypes: profile?.target_roles?.archetypes || [],
    positiveKeywords: portals?.title_filter?.positive || [],
    seniorityBoost: portals?.title_filter?.seniority_boost || [],
  };
}
