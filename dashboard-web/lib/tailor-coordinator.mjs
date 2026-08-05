import { canonicalCompanyRoleKey } from '../../lib/role-identity.mjs';
import { asWorkspace } from '../../lib/workspace.mjs';
import {
  appendTailorReportSection,
  runTailor,
  writeTailorReport,
} from '../../lib/tailor.mjs';
import { parseApplications } from './parsers.mjs';
import { enforcePipelineConsistency, markPipelineTailored } from './writers.mjs';

function sameRole(app, input) {
  return canonicalCompanyRoleKey(app?.company, app?.role)
    === canonicalCompanyRoleKey(input?.company, input?.role);
}

function existingBundle(ws, app) {
  const bundle = app?.tailorBundle;
  const paths = bundle?.paths || {};
  if (!paths.cv || !paths.coverLetter) return null;
  if (!ws.exists(paths.cv) || !ws.exists(paths.coverLetter)) return null;
  return bundle;
}

function findRoleApp(apps, input, ws) {
  return apps
    .filter((app) => sameRole(app, input))
    .sort((left, right) => {
      const leftRank = (left.reportPath ? 2 : 0) + (existingBundle(ws, left) ? 1 : 0);
      const rightRank = (right.reportPath ? 2 : 0) + (existingBundle(ws, right) ? 1 : 0);
      return rightRank - leftRank;
    })[0] || null;
}

function findUnboundReport(ws, input) {
  const inputUrl = String(input?.url || '').trim();
  const inputKey = canonicalCompanyRoleKey(input?.company, input?.role);
  const matches = [];
  for (const entry of ws.list('reports', { filter: (candidate) => candidate.isFile && /^\d+-.*\.md$/i.test(candidate.name) })) {
    const path = `reports/${entry.name}`;
    const raw = ws.read(path) || '';
    const reportUrl = raw.match(/^\*\*URL:\*\*\s*(\S+)/mi)?.[1] || '';
    const company = raw.match(/^\*\*Company:\*\*\s*(.+)$/mi)?.[1]?.trim() || '';
    const role = raw.match(/^\*\*Role:\*\*\s*(.+)$/mi)?.[1]?.trim() || '';
    const metadataMatch = company && role && canonicalCompanyRoleKey(company, role) === inputKey;
    const urlMatch = inputUrl && reportUrl === inputUrl;
    if (!urlMatch && !metadataMatch) continue;
    const number = entry.name.match(/^(\d+)-/)?.[1] || '';
    matches.push({
      company: company || input.company,
      role: role || input.role,
      reportPath: path,
      reportNumber: number,
      matchRank: urlMatch ? 2 : 1,
    });
  }
  matches.sort((left, right) => right.matchRank - left.matchRank
    || Number(right.reportNumber || 0) - Number(left.reportNumber || 0));
  return matches[0] || null;
}

function findRoleContext(apps, input, ws) {
  const app = findRoleApp(apps, input, ws);
  if (app?.reportPath && ws.exists(app.reportPath)) return app;
  const report = findUnboundReport(ws, input);
  return report ? { ...app, ...report } : app;
}

function parseQaPairs(raw = '') {
  const pairs = [];
  const pattern = /^##\s+\d+\.\s+(.+)\n+([\s\S]*?)(?=^##\s+\d+\.|\s*$)/gm;
  for (const match of String(raw).matchAll(pattern)) {
    pairs.push({ question: match[1].trim(), answer: match[2].trim() });
  }
  return pairs;
}

function resultFromBundle(ws, app, bundle) {
  const paths = bundle.paths || {};
  return {
    slug: bundle.slug || String(bundle.dir || '').replace(/^output\/tailor-bundles\//, ''),
    dir: bundle.dir,
    paths,
    payload: {
      tailored_cv_markdown: ws.read(paths.cv) || '',
      cover_letter_markdown: ws.read(paths.coverLetter) || '',
      qa_pairs: paths.qa ? parseQaPairs(ws.read(paths.qa) || '') : [],
    },
  };
}

function reportFromApp(app) {
  if (!app?.reportPath) return null;
  return {
    path: app.reportPath,
    filename: app.reportPath.split('/').pop(),
    number: app.reportNumber || '',
    existing: true,
  };
}

function responseFor(result, report, { reused = false, repaired = false } = {}) {
  const payload = result.payload || {};
  return {
    success: true,
    reused,
    repaired,
    slug: result.slug,
    dir: result.dir,
    paths: result.paths,
    report,
    preview: {
      cv_excerpt: String(payload.tailored_cv_markdown || '').slice(0, 1200),
      cover_letter_excerpt: String(payload.cover_letter_markdown || '').slice(0, 1200),
      qa_count: Array.isArray(payload.qa_pairs) ? payload.qa_pairs.length : 0,
      qa_first: Array.isArray(payload.qa_pairs) ? payload.qa_pairs.slice(0, 2) : [],
    },
  };
}

/**
 * Coordinate expensive tailor requests for one dashboard process.
 *
 * Same-role operations are coalesced by canonical identity. Report creation is
 * serialized across roles, while writeTailorReport also uses exclusive file
 * creation to protect against another process choosing the same number.
 */
export function createTailorCoordinator({
  root,
  workspace = asWorkspace(root),
  runTailorFn = runTailor,
  generatePdfs = async () => {},
  parseApplicationsFn = parseApplications,
  markPipelineTailoredFn = markPipelineTailored,
  enforcePipelineConsistencyFn = enforcePipelineConsistency,
  appendTailorReportSectionFn = appendTailorReportSection,
  writeTailorReportFn = writeTailorReport,
} = {}) {
  const ws = asWorkspace(workspace);
  const workspaceRoot = root || ws.root;
  const inFlight = new Map();
  let reportWrites = Promise.resolve();

  const serializeReportWrite = (operation) => {
    const current = reportWrites.then(operation, operation);
    reportWrites = current.catch(() => {});
    return current;
  };

  const bindResult = (input, result, report) => {
    const latestApp = findRoleApp(parseApplicationsFn(workspaceRoot), input, ws);
    markPipelineTailoredFn(workspaceRoot, {
      url: input.url,
      company: latestApp?.company || input.company,
      role: latestApp?.role || input.role,
      reportPath: report.path,
      reportNumber: report.number || latestApp?.reportNumber || '',
      hasPdf: Boolean(result.paths?.cvPdf && ws.exists(result.paths.cvPdf)),
    });
    enforcePipelineConsistencyFn(workspaceRoot);
  };

  const ensureReport = (input, result, preferredApp = null) => serializeReportWrite(() => {
    const latestApp = findRoleContext(parseApplicationsFn(workspaceRoot), input, ws) || preferredApp;
    const existing = reportFromApp(latestApp);
    if (existing && ws.exists(existing.path)) {
      const appended = appendTailorReportSectionFn(ws, existing.path, result);
      if (appended) return existing;
    }
    return writeTailorReportFn(ws, result, input);
  });

  const execute = async (input, runAgent) => {
    const currentApp = findRoleContext(parseApplicationsFn(workspaceRoot), input, ws);
    const completeBundle = existingBundle(ws, currentApp);

    if (!input.force && completeBundle) {
      const result = resultFromBundle(ws, currentApp, completeBundle);
      let report = reportFromApp(currentApp);
      const repaired = !report || !ws.exists(report.path);
      if (repaired) report = await ensureReport(input, result, currentApp);
      bindResult(input, result, report);
      return responseFor(result, report, { reused: true, repaired });
    }

    const result = await runTailorFn({
      company: input.company,
      role: input.role,
      url: input.url,
      jd: input.jd,
      workspace: ws,
      runAgent,
    });
    await generatePdfs(ws, result.paths);
    const report = await ensureReport(input, result, currentApp);
    bindResult(input, result, report);
    return responseFor(result, report, { reused: false });
  };

  const tailor = (rawInput = {}, { runAgent } = {}) => {
    const input = { ...rawInput, force: rawInput.force === true };
    const key = canonicalCompanyRoleKey(input.company, input.role);
    if (!key || key === '||') return Promise.reject(new Error('company and role are required'));
    const pending = inFlight.get(key);
    if (pending) return pending;

    const operation = execute(input, runAgent);
    inFlight.set(key, operation);
    operation.finally(() => {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    }).catch(() => {});
    return operation;
  };

  return { tailor };
}
