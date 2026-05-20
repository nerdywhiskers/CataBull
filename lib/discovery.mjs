/**
 * lib/discovery.mjs — W7 verified discovery orchestrator.
 *
 * Replaces "agent guesses URL → save → W1 catches breakage later" with
 * verify-then-save. Per-company flow:
 *
 *   1. Agent verifies the careers URL via WebSearch + sniff (the agent
 *      has WebSearch and WebFetch tools; we let it use them rather than
 *      reimplement search engines in Node).
 *   2. W1 health check confirms reachability and pulls a sample posting
 *      list.
 *   3. Role-fit pre-flight applies the user's title filter to the sample
 *      jobs and categorises:
 *        - matches (≥1 sample posting passes the filter)
 *        - no_current_matches (0 matches, but ≥5 jobs returned)
 *        - empty (0 jobs returned)
 *
 * Designed for testability: every dependency (verify, health check,
 * title filter) is injectable. The default wiring uses runAgentPrint
 * and scan/health.mjs's checkCompany.
 *
 * See docs/archive/DISCOVERY_QUALITY.md (W7) for the spec.
 */

import { checkCompany } from '../scan/health.mjs';
import { runAgentPrint } from '../dashboard-web/lib/agents.mjs';
import { buildTitleFilter } from './title-filter.mjs';

// Default concurrency for parallel candidate verification. Each candidate
// triggers an agent run (WebSearch + WebFetch) plus an HTTP health check —
// 5 in flight is the right balance between throughput and not melting the
// agent CLI's process pool.
export const DEFAULT_CONCURRENCY = 5;

// Cap on how many sample jobs the role-fit categorizer needs to see before
// it can decide between "empty" and "no current matches". Mirrors the
// W7 spec ("0 matches but ≥5 jobs returned").
export const ROLE_FIT_MIN_JOB_SAMPLE = 5;

/**
 * Categorize a sample posting list against a title filter predicate.
 *
 * Returns one of:
 *   - 'matches'              — ≥1 job in the sample passes the filter
 *   - 'no_current_matches'   — 0 matches but the sample has ≥5 jobs
 *                              (the company is hiring, just not for this user)
 *   - 'empty'                — fewer than 5 sample jobs (possibly a hiring
 *                              freeze, or the parser only saw a partial page)
 *
 * Pure function for unit testing.
 */
export function categorizeRoleFit(jobs, titleFilterPredicate) {
  const list = Array.isArray(jobs) ? jobs : [];
  const matchCount = list.filter((j) => titleFilterPredicate(j.title || '')).length;
  if (matchCount > 0) return { fit: 'matches', matchCount, totalSampled: list.length };
  if (list.length >= ROLE_FIT_MIN_JOB_SAMPLE) {
    return { fit: 'no_current_matches', matchCount: 0, totalSampled: list.length };
  }
  return { fit: 'empty', matchCount: 0, totalSampled: list.length };
}

/**
 * Build the per-company verification prompt. Exported for testability and
 * for callers that want to drive the agent themselves (e.g. W8 URL
 * recovery, which scopes the same flow to a single auto-disabled
 * company name).
 *
 * The agent is expected to use its built-in WebSearch + WebFetch tools
 * to find the canonical careers URL; we don't try to reimplement search
 * engines here.
 */
export function verifyCompanyUrlPrompt(companyName, { maxHits = 5 } = {}) {
  return [
    `You are verifying the canonical careers URL for: "${companyName}"`,
    '',
    `Run WebSearch for "${companyName} careers" and inspect up to ${maxHits} top hits.`,
    'For each hit, follow links until you land on a known ATS host:',
    '  - greenhouse.io / job-boards.greenhouse.io / boards.greenhouse.io',
    '  - jobs.ashbyhq.com',
    '  - jobs.lever.co',
    '  - *.myworkdayjobs.com',
    '  - *.bamboohr.com',
    '  - *.teamtailor.com',
    'A company\'s branded careers page (e.g. company.com/careers) is acceptable',
    'ONLY if it loads as a real careers page with visible job listings.',
    '',
    'Output ONE JSON object and NOTHING else:',
    '{',
    '  "careers_url": "<canonical URL>",  // null if you can\'t find one',
    '  "provider": "<greenhouse|ashby|lever|workday|bamboohr|teamtailor|webfetch|null>",',
    '  "confidence": "high|medium|low",   // high = direct ATS hit, medium = branded page with visible jobs, low = best guess',
    '  "notes": "<one short sentence about what you found>"',
    '}',
    '',
    'Return null for careers_url rather than guessing. We would rather drop',
    'this candidate than save a broken link.',
  ].join('\n');
}

function extractJsonObject(text) {
  if (!text) return null;
  const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : String(text);
  const match = candidate.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * Default verifier: drives the user's CLI agent (Claude Code / Codex / etc.)
 * to do the WebSearch + sniff. Used by discoverCompany unless the caller
 * injects a custom `verify` function.
 *
 * The agent must already be configured (`agent` arg). `workspaceRoot` is
 * passed through to runAgentPrint as the cwd.
 */
export async function defaultVerifier(name, { agent, workspaceRoot, timeoutMs = 180_000 } = {}) {
  if (!agent) throw new Error('verifier needs an agent name');
  const prompt = verifyCompanyUrlPrompt(name);
  const out = await runAgentPrint(agent, prompt, workspaceRoot, {
    timeoutMs,
    allowEdits: false,
    rejectOnError: true,
  });
  const parsed = extractJsonObject(out.output || '');
  if (!parsed || typeof parsed.careers_url !== 'string' || !parsed.careers_url.trim()) {
    return null;
  }
  if (!/^https?:\/\//i.test(parsed.careers_url.trim())) return null;
  return {
    careers_url: parsed.careers_url.trim(),
    provider: parsed.provider || null,
    confidence: parsed.confidence || 'medium',
    notes: String(parsed.notes || '').slice(0, 200),
  };
}

/**
 * Verify, health-check, and role-fit a single candidate.
 *
 * Inputs:
 *   - candidate: { name, industries?, notes? }
 *   - opts:
 *       verify        — async (name) => { careers_url, provider, ... } | null
 *       checkCompany  — async (company) => health record
 *       titleFilter   — { positive: [], negative: [] }  (from portals.yml)
 *
 * Returns:
 *   {
 *     name, careers_url, provider, status,
 *     role_fit, role_fit_meta, sample_jobs,
 *     health, verify, error?
 *   }
 *
 * status is one of:
 *   - 'enabled'         — passed health + role-fit; safe to add as enabled:true
 *   - 'disabled_no_url' — couldn't resolve a careers URL
 *   - 'disabled_health' — URL resolved but health check failed
 *   - 'disabled_no_fit' — URL healthy but no current matches in sample
 *   - 'disabled_empty'  — URL healthy but parser returned <5 jobs
 *   - 'error'           — unexpected failure during orchestration
 */
export async function discoverCompany(candidate, opts = {}) {
  const {
    verify = defaultVerifier,
    checkCompany: checkCompanyFn = checkCompany,
    titleFilter = null,
    verifyOpts = {},
  } = opts;

  if (!candidate || typeof candidate.name !== 'string' || !candidate.name.trim()) {
    return { status: 'error', error: 'candidate.name is required' };
  }

  const name = candidate.name.trim();

  // Step 1 — verify URL
  let verifyResult;
  try {
    verifyResult = await verify(name, verifyOpts);
  } catch (err) {
    return {
      name,
      status: 'error',
      error: `verify failed: ${err.message || err}`,
    };
  }

  if (!verifyResult || !verifyResult.careers_url) {
    return {
      name,
      status: 'disabled_no_url',
      verify: verifyResult || null,
    };
  }

  // Step 2 — health check the resolved URL
  const candidateForHealth = {
    name,
    careers_url: verifyResult.careers_url,
    industries: Array.isArray(candidate.industries) ? candidate.industries : [],
    enabled: true,
  };
  let health;
  try {
    health = await checkCompanyFn(candidateForHealth);
  } catch (err) {
    return {
      name,
      careers_url: verifyResult.careers_url,
      status: 'error',
      error: `health check failed: ${err.message || err}`,
      verify: verifyResult,
    };
  }

  const isHealthy = ['healthy', 'empty'].includes(health?.status);
  if (!isHealthy) {
    return {
      name,
      careers_url: verifyResult.careers_url,
      provider: verifyResult.provider || health?.provider || null,
      status: 'disabled_health',
      health,
      verify: verifyResult,
    };
  }

  // Step 3 — role-fit pre-flight on the sample postings the health check
  // already pulled. If no titleFilter was provided, skip role-fit and
  // just enable.
  const sample = Array.isArray(health.sampleJobs)
    ? health.sampleJobs
    : Array.isArray(health.jobs)
      ? health.jobs
      : [];
  let role_fit_meta = { fit: 'matches', matchCount: 0, totalSampled: sample.length };
  if (titleFilter) {
    const predicate = buildTitleFilter(titleFilter);
    role_fit_meta = categorizeRoleFit(sample, predicate);
  }

  let status;
  if (role_fit_meta.fit === 'matches') status = 'enabled';
  else if (role_fit_meta.fit === 'no_current_matches') status = 'disabled_no_fit';
  else status = 'disabled_empty';

  return {
    name,
    careers_url: verifyResult.careers_url,
    provider: verifyResult.provider || health?.provider || null,
    status,
    role_fit: role_fit_meta.fit,
    role_fit_meta,
    sample_jobs: sample.slice(0, 10),
    health,
    verify: verifyResult,
  };
}

/**
 * Process many candidates in parallel with bounded concurrency.
 *
 * Inputs:
 *   - candidates: [{ name, ... }]
 *   - opts: same as discoverCompany; plus { concurrency, onProgress }
 *
 * onProgress is called as each candidate finishes:
 *   onProgress({ done, total, name, status })
 *
 * Returns: array of discoverCompany results, in the same order as input.
 */
export async function discoverCompanies(candidates, opts = {}) {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    onProgress = null,
    ...candidateOpts
  } = opts;

  const list = Array.isArray(candidates) ? candidates : [];
  const results = new Array(list.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= list.length) return;
      try {
        results[idx] = await discoverCompany(list[idx], candidateOpts);
      } catch (err) {
        results[idx] = {
          name: list[idx]?.name,
          status: 'error',
          error: err.message || String(err),
        };
      }
      done++;
      if (onProgress) {
        try {
          onProgress({
            done,
            total: list.length,
            name: results[idx]?.name,
            status: results[idx]?.status,
          });
        } catch { /* progress callback errors are non-fatal */ }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Build a one-line provenance note for portals.yml from a discoverCompany
 * result. Used by the onboarding route when merging survivors into the
 * tracked_companies list.
 */
export function buildProvenanceNote(result, { date = new Date().toISOString().slice(0, 10) } = {}) {
  if (!result) return '';
  const parts = [`Auto-discovered ${date}`];
  if (result.verify?.confidence) parts.push(`URL via WebSearch (${result.verify.confidence} confidence)`);
  if (result.role_fit_meta) {
    const { matchCount, totalSampled } = result.role_fit_meta;
    if (totalSampled > 0) {
      parts.push(`${matchCount} of ${totalSampled} sample postings matched title filter`);
    }
  }
  if (result.status && result.status !== 'enabled') {
    parts.push(`disabled: ${result.status.replace('disabled_', '')}`);
  }
  return parts.join('; ') + '.';
}
