/**
 * routes/health.mjs — Scan health check API
 *
 * Exposes the per-company portal health classifier (scan/health.mjs) to
 * the dashboard. Heavy work (running checks across all companies) is
 * triggered explicitly via POST /health/check; cached results live in
 * data/scan-health.json and are served via GET /health/status.
 *
 * W4: after each check we also patch portals.yml with per-company
 * health metadata (last_ok / last_check / consecutive_failures /
 * last_error) and auto-disable companies that hit the failure
 * threshold. data/scan-health.log captures every state transition.
 *
 * See docs/archive/SCAN_RELIABILITY.md (workstreams W1 + W4) for design.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import {
  checkCompanies,
  checkCompany,
  suggestedAction,
  HEALTH_STATUSES,
  applyHealthResult,
  shouldAutoDisable,
  AUTO_DISABLE_THRESHOLD,
} from '../../scan/health.mjs';
import { writePortals, readProfile, updateCompany } from '../lib/writers.mjs';
import { discoverCompany, defaultVerifier } from '../../lib/discovery.mjs';
import { runAgentPrint } from '../lib/agents.mjs';

export function createActiveChildController() {
  let active = null;
  let disconnected = false;
  const terminate = (proc) => {
    if (!proc || proc.killed) return;
    try { proc.kill('SIGTERM'); } catch { /* best effort */ }
  };
  return {
    get disconnected() { return disconnected; },
    set(proc) {
      active = proc;
      if (disconnected) terminate(proc);
    },
    clear(proc) {
      if (active === proc) active = null;
    },
    disconnect() {
      disconnected = true;
      terminate(active);
    },
  };
}

// In-flight tracking — reject overlapping POSTs so we don't run two
// health sweeps in parallel against the same chromium pool.
let inFlight = null;

function loadPortals(root) {
  const path = join(root, 'portals.yml');
  if (!existsSync(path)) return null;
  try {
    return yaml.load(readFileSync(path, 'utf-8')) || {};
  } catch {
    return null;
  }
}

function healthPath(root) {
  return join(root, 'data', 'scan-health.json');
}

function readSnapshot(root) {
  const path = healthPath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSnapshot(root, snapshot) {
  const path = healthPath(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf-8');
}

function appendHealthLog(root, line) {
  const path = join(root, 'data', 'scan-health.log');
  mkdirSync(join(root, 'data'), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()}\t${line}\n`, 'utf-8');
}

/**
 * W4: merge a freshly-completed health snapshot's results back into
 * portals.yml. For each result we update the company's `health:` block,
 * and if the consecutive_failures threshold has been crossed we also
 * flip enabled to false and stamp `auto_disabled: true` so the user
 * can later distinguish "I disabled this" from "the system did".
 *
 * Re-enabling a company (anywhere) clears the auto_disabled flag —
 * that's a free signal because writePortals doesn't preserve fields
 * the user removes via the UI.
 *
 * Returns { autoDisabled: [name, ...], updated: count } so the
 * dashboard can surface how many companies got auto-disabled by
 * this run.
 */
function persistHealthMetadata(root, snapshot) {
  const portals = loadPortals(root);
  if (!portals || !Array.isArray(portals.tracked_companies)) {
    return { autoDisabled: [], updated: 0 };
  }
  const byName = new Map(portals.tracked_companies.map((c) => [c.name, c]));
  const autoDisabled = [];
  let updated = 0;

  for (const result of (snapshot.companies || [])) {
    const company = byName.get(result.name);
    if (!company) continue;
    const prior = company.health;
    const next = applyHealthResult(prior, result);
    company.health = next;
    updated++;

    const { disable } = shouldAutoDisable(next);
    const wasEnabled = company.enabled !== false;
    if (disable && wasEnabled) {
      // Cross the threshold: auto-disable + log + remember it was the
      // system, not the user. The user can re-enable from the UI.
      company.enabled = false;
      company.auto_disabled = true;
      autoDisabled.push(company.name);
      appendHealthLog(
        root,
        `auto_disabled\t${company.name}\t${result.status}\t${(result.error || '').slice(0, 200)}`,
      );
    } else if (!disable && company.auto_disabled && next.consecutive_failures === 0) {
      // Recovered after manual re-enable + a successful check. Clear
      // the flag so the company looks like a normal user-tracked one
      // again.
      delete company.auto_disabled;
      appendHealthLog(root, `recovered\t${company.name}\t${result.status}`);
    }
  }

  if (updated > 0) {
    writePortals(root, portals);
  }
  return { autoDisabled, updated };
}

function decorate(snapshot) {
  if (!snapshot?.companies) return snapshot;
  return {
    ...snapshot,
    companies: snapshot.companies.map((c) => ({ ...c, action: suggestedAction(c.status) })),
  };
}

export default async function (app) {
  const root = app.cataBullRoot;

  // GET /health/status — return the most recent snapshot (or null if none).
  app.get('/health/status', async () => {
    const snapshot = readSnapshot(root);
    if (!snapshot) return { snapshot: null, statuses: HEALTH_STATUSES };
    return { snapshot: decorate(snapshot), statuses: HEALTH_STATUSES };
  });

  // POST /health/check — run a fresh check across all (or filtered) companies.
  // Body: { includeDisabled?: boolean, company?: string }
  app.post('/health/check', async (req, reply) => {
    if (inFlight) {
      return reply.code(409).send({ error: 'A health check is already in progress.' });
    }

    const portals = loadPortals(root);
    if (!portals) {
      return reply.code(400).send({ error: 'portals.yml not found or unreadable.' });
    }

    const all = Array.isArray(portals.tracked_companies) ? portals.tracked_companies : [];
    let companies = req.body?.includeDisabled
      ? all
      : all.filter((c) => c.enabled !== false);

    const filter = req.body?.company ? String(req.body.company).toLowerCase() : null;
    if (filter) companies = companies.filter((c) => c.name.toLowerCase().includes(filter));

    if (companies.length === 0) {
      return reply.code(400).send({ error: 'No companies match the filter.' });
    }

    // Health checks against ~16 companies typically finish in 30-60s but
    // worst case (lots of webfetch + Playwright timeouts) can hit 2-3 min.
    // Pad the raw socket timeout so the response can still be delivered.
    reply.raw.setTimeout(5 * 60 * 1000);

    inFlight = (async () => {
      const snapshot = await checkCompanies(companies);
      writeSnapshot(root, snapshot);
      const { autoDisabled, updated } = persistHealthMetadata(root, snapshot);
      snapshot.autoDisabled = autoDisabled;
      snapshot.companiesUpdated = updated;
      snapshot.autoDisableThreshold = AUTO_DISABLE_THRESHOLD;
      return snapshot;
    })();

    try {
      const snapshot = await inFlight;
      return { snapshot: decorate(snapshot), statuses: HEALTH_STATUSES };
    } catch (err) {
      return reply.code(500).send({ error: err.message || 'Health check failed.' });
    } finally {
      inFlight = null;
    }
  });

  // POST /health/check/:company — recheck one company without rewriting
  // the whole snapshot. Useful for the per-row "Recheck" button.
  app.post('/health/check/:company', async (req, reply) => {
    const portals = loadPortals(root);
    if (!portals) return reply.code(400).send({ error: 'portals.yml not found.' });

    const target = (req.params.company || '').toLowerCase();
    const company = (portals.tracked_companies || []).find(
      (c) => c.name.toLowerCase() === target,
    );
    if (!company) return reply.code(404).send({ error: 'Company not found in portals.yml.' });

    const result = await checkCompany(company);
    const decorated = { ...result, action: suggestedAction(result.status) };

    // Patch the existing snapshot in place so the dashboard doesn't have
    // to refetch the whole list after a single recheck.
    const snapshot = readSnapshot(root);
    if (snapshot && Array.isArray(snapshot.companies)) {
      const idx = snapshot.companies.findIndex((c) => c.name === company.name);
      if (idx >= 0) snapshot.companies[idx] = result;
      else snapshot.companies.push(result);
      // Recompute summary from the patched list.
      snapshot.summary = HEALTH_STATUSES.reduce((acc, s) => {
        acc[s] = snapshot.companies.filter((c) => c.status === s).length;
        return acc;
      }, {});
      snapshot.finishedAt = new Date().toISOString();
      writeSnapshot(root, snapshot);
    }

    // W4: also patch the company's health block in portals.yml. We
    // build a minimal snapshot ({ companies: [result] }) so the same
    // helper handles single-company rechecks and full sweeps.
    const { autoDisabled } = persistHealthMetadata(root, { companies: [result] });

    return { result: decorated, autoDisabled };
  });

  // ── W8 — URL recovery for auto-disabled companies ─────────────────
  //
  // POST /health/recover/:company
  //   Runs lib/discovery on the existing company name. Returns a proposed
  //   new careers_url plus role-fit context. Does NOT mutate portals.yml —
  //   user data per CLAUDE.md, the proposal needs explicit acceptance.
  //
  // POST /health/recover/:company/accept body: { url }
  //   Applies the URL: updates careers_url, sets enabled=true, clears
  //   auto_disabled, resets consecutive_failures.
  app.post('/health/recover/:company', async (req, reply) => {
    const portals = loadPortals(root);
    if (!portals) return reply.code(400).send({ error: 'portals.yml not found.' });

    const target = (req.params.company || '').toLowerCase();
    const company = (portals.tracked_companies || []).find(
      (c) => c.name.toLowerCase() === target,
    );
    if (!company) return reply.code(404).send({ error: 'Company not found in portals.yml.' });

    const profile = readProfile(root) || {};
    const agent = profile?.preferences?.agent || req.body?.agent;
    if (!agent) {
      return reply.code(400).send({
        error: 'No agent configured — recovery uses the agent\'s WebSearch tool to find the new URL.',
      });
    }

    const titleFilter = portals.title_filter || null;
    // Recovery runs the same W7 pipeline scoped to one name — agent
    // verifies via WebSearch, we run W1 health, then role-fit pre-flight.
    const verifyTimeout = 180_000;
    reply.raw.setTimeout(verifyTimeout + 60_000);

    let result;
    try {
      result = await discoverCompany(
        { name: company.name, industries: company.industries },
        {
          verify: (name) => defaultVerifier(name, { agent, workspaceRoot: root, timeoutMs: verifyTimeout }),
          titleFilter,
        }
      );
    } catch (err) {
      return reply.code(502).send({ error: `Recovery failed: ${err.message || err}` });
    }

    return {
      success: true,
      company: company.name,
      old_url: company.careers_url || null,
      proposed_url: result.careers_url || null,
      provider: result.provider || null,
      status: result.status,                // 'enabled' / 'disabled_*' / 'error'
      role_fit: result.role_fit || null,    // 'matches' / 'no_current_matches' / 'empty'
      role_fit_meta: result.role_fit_meta || null,
      sample_jobs: Array.isArray(result.sample_jobs) ? result.sample_jobs.slice(0, 5) : [],
      verify_confidence: result.verify?.confidence || null,
      verify_notes: result.verify?.notes || null,
      // For UI clarity. The actual write happens via /accept once the
      // user confirms the proposal.
      requires_acceptance: Boolean(result.careers_url) && result.careers_url !== company.careers_url,
    };
  });

  app.post('/health/recover/:company/accept', async (req, reply) => {
    const portals = loadPortals(root);
    if (!portals) return reply.code(400).send({ error: 'portals.yml not found.' });

    const target = (req.params.company || '').toLowerCase();
    const company = (portals.tracked_companies || []).find(
      (c) => c.name.toLowerCase() === target,
    );
    if (!company) return reply.code(404).send({ error: 'Company not found in portals.yml.' });

    const newUrl = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(newUrl)) {
      return reply.code(400).send({ error: 'A valid http(s) url is required.' });
    }

    // Apply the URL change and clear the auto-disable / decay state so
    // W4 doesn't immediately re-disable the company before the next
    // health check runs.
    const updates = {
      careers_url: newUrl,
      enabled: true,
      auto_disabled: false,
      health: {
        ...(company.health || {}),
        consecutive_failures: 0,
        last_error: undefined,
      },
    };
    const ok = updateCompany(root, company.name, updates);
    if (!ok) return reply.code(500).send({ error: 'Failed to update portals.yml.' });

    return {
      success: true,
      company: company.name,
      old_url: company.careers_url || null,
      new_url: newUrl,
    };
  });

  // ── Fix Broken Links — bulk auto-recover broken portals ─────────────
  //
  // POST /health/fix-broken-links
  //   Runs scripts/healthcheck.mjs recover + apply against the most recent
  //   baseline (data/scan-health.json). Pure Node — does NOT call any
  //   LLM/agent — so it works regardless of which agent (or none) the user
  //   has configured.
  //
  // Streams progress as text/event-stream chunks: each line is a JSON
  // object with `{ phase, done, total, name, recovered? }` for live UI
  // updates. Final event is `{ done: true, applied, recovered, total }`.
  //
  // Long-running (~5-15 min for 100+ broken). The HTTP timeout is bumped
  // to 30 min and the child process is killed if the client disconnects
  // mid-stream.
  let bulkFixInFlight = null;

  app.post('/health/fix-broken-links', async (req, reply) => {
    if (bulkFixInFlight) {
      return reply.code(409).send({ error: 'A fix-broken-links run is already in progress.' });
    }
    if (!existsSync(healthPath(root))) {
      return reply.code(400).send({
        error: 'No baseline found. Run "Run Health Check All" first to generate data/scan-health.json.',
      });
    }

    reply.raw.setTimeout(30 * 60 * 1000);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering if any
    });

    const send = (obj) => {
      try {
        reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch { /* client gone — caught by close handler below */ }
    };

    const childController = createActiveChildController();
    req.raw.on('close', () => childController.disconnect());

    // Spawn the recover step first. Pipe its stdout so we can echo the
    // per-company `[N/M] CompanyName ✓` lines back to the client as
    // progress events. The script writes machine-friendly summaries
    // alongside, but we're already in a streaming context so the line-
    // level output is enough for a progress bar.
    const recoverProc = spawn(process.execPath, [join(app.packageRoot, 'scripts/healthcheck.mjs'), 'recover'], {
      cwd: root,
      env: { ...process.env, CATABULL_WORKSPACE_ROOT: root },
    });
    bulkFixInFlight = recoverProc;
    childController.set(recoverProc);

    let phase1Total = 0;
    let phase2Total = 0;
    let currentPhase = 1;
    let recoveredCount = 0;

    const onData = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (/^Phase 1 —/.test(line)) {
          currentPhase = 1;
          const m = line.match(/\((\d+) candidates/);
          if (m) phase1Total = Number(m[1]);
          send({ event: 'phase_start', phase: 1, total: phase1Total });
          continue;
        }
        if (/^Phase 2 —/.test(line)) {
          currentPhase = 2;
          const m = line.match(/\((\d+) candidates/);
          if (m) phase2Total = Number(m[1]);
          send({ event: 'phase_start', phase: 2, total: phase2Total });
          continue;
        }
        // `[ 12/164] CompanyName                ✓ greenhouse/foo (10 jobs)`
        const progress = line.match(/^\[\s*(\d+)\/(\d+)\]\s+(.+?)\s+([✓·])\s*(.*)$/);
        if (progress) {
          const [, done, total, name, glyph, tail] = progress;
          const recovered = glyph === '✓';
          if (recovered) recoveredCount += 1;
          send({
            event: 'company_done',
            phase: currentPhase,
            done: Number(done),
            total: Number(total),
            name: name.trim(),
            recovered,
            detail: tail.trim() || null,
          });
        }
      }
    };
    recoverProc.stdout.on('data', onData);
    recoverProc.stderr.on('data', onData);

    const recoverExit = await new Promise((res) => recoverProc.on('close', res));
    childController.clear(recoverProc);
    if (recoverExit !== 0) {
      send({ event: 'error', step: 'recover', exitCode: recoverExit });
      reply.raw.end();
      bulkFixInFlight = null;
      return;
    }
    if (childController.disconnected) {
      bulkFixInFlight = null;
      return;
    }

    send({ event: 'apply_start' });

    // Apply step — non-interactive, just runs and reports the count back.
    const applyProc = spawn(process.execPath, [join(app.packageRoot, 'scripts/healthcheck.mjs'), 'apply'], {
      cwd: root,
      env: { ...process.env, CATABULL_WORKSPACE_ROOT: root },
    });
    bulkFixInFlight = applyProc;
    childController.set(applyProc);

    let appliedCount = 0;
    let stderrTail = '';
    applyProc.stdout.on('data', (buf) => {
      const text = buf.toString();
      const m = text.match(/Applied (\d+) changes to portals\.yml/);
      if (m) appliedCount = Number(m[1]);
    });
    applyProc.stderr.on('data', (buf) => {
      stderrTail += buf.toString();
      if (stderrTail.length > 1024) stderrTail = stderrTail.slice(-1024);
    });

    const applyExit = await new Promise((res) => applyProc.on('close', res));
    childController.clear(applyProc);
    if (applyExit !== 0) {
      send({ event: 'error', step: 'apply', exitCode: applyExit, detail: stderrTail.trim().slice(0, 400) });
      reply.raw.end();
      bulkFixInFlight = null;
      return;
    }

    // Refresh the health snapshot in portals.yml metadata so the dashboard
    // health pills reflect the freshly-applied URLs. Cheap: just persists
    // what's already in scan-health.json.
    const snapshot = readSnapshot(root);
    if (snapshot) {
      const meta = persistHealthMetadata(root, snapshot);
      send({ event: 'metadata_synced', updated: meta.updated });
    }

    send({
      event: 'done',
      recovered: recoveredCount,
      applied: appliedCount,
    });
    reply.raw.end();
    bulkFixInFlight = null;
  });
}
