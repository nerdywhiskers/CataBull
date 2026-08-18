/**
 * dashboard-web/lib/writers.mjs — User-data write helpers.
 *
 * All disk access goes through the Workspace abstraction (lib/workspace.mjs)
 * so this module is forward-compatible with hosted/multi-tenant storage
 * backends.
 *
 * Functions accept either a workspace-relative root string (legacy) or
 * a Workspace instance — `asWorkspace()` normalizes at the boundary.
 */

import { asWorkspace } from '../../lib/workspace.mjs';
import { canonicalCompanyRoleKey } from '../../lib/role-identity.mjs';
// Cyclic import is fine: parsers.mjs imports `applicationsPath` from this
// file but only at function call time (not module top), and we import
// `parseApplications` the same way. ESM resolves both bindings before
// either function runs.
import { parseApplications } from './parsers.mjs';

export { canonicalCompanyRoleKey } from '../../lib/role-identity.mjs';

/** Resolve the canonical applications.md path.
 * Checks data/applications.md first (newer convention), falls back to root.
 */
export function applicationsPath(root) {
  const ws = asWorkspace(root);
  if (ws.exists('data/applications.md')) return ws.resolve('data/applications.md');
  return ws.resolve('applications.md');
}

export function applicationEventsPath(root) {
  const ws = asWorkspace(root);
  return ws.resolve('data/application-events.tsv');
}

function sanitizeEventField(value) {
  return String(value || '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureApplicationEventsFile(ws) {
  const relPath = 'data/application-events.tsv';
  const existing = ws.read(relPath);
  if (existing != null) return existing;
  const header = 'tracker_row_id\tdate\tcompany\trole\tevent\tnotes\n';
  ws.write(relPath, header);
  return header;
}

function statusToApplicationEvent(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'applied') return 'applied';
  if (normalized === 'responded') return 'responded';
  if (normalized === 'interview' || normalized === 'interviewed') return 'interview';
  if (normalized === 'offer') return 'offer';
  if (normalized === 'rejected') return 'rejected';
  if (normalized === 'discarded') return 'discarded';
  if (normalized === 'skip' || normalized === 'skipped') return 'skipped';
  if (normalized.includes('tailor') || normalized.includes('evaluat')) return 'tailored';
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function appendApplicationEvent(root, {
  trackerRowId,
  date = new Date().toISOString().slice(0, 10),
  company,
  role,
  event,
  notes = '',
} = {}) {
  const ws = asWorkspace(root);
  const rowId = sanitizeEventField(trackerRowId);
  const eventName = sanitizeEventField(event);
  const companyName = sanitizeEventField(company);
  const roleName = sanitizeEventField(role);
  if (!rowId || !eventName || !companyName || !roleName) return false;

  const existing = ensureApplicationEventsFile(ws);
  const line = [
    rowId,
    sanitizeEventField(date) || new Date().toISOString().slice(0, 10),
    companyName,
    roleName,
    eventName,
    sanitizeEventField(notes),
  ].join('\t');
  ws.write('data/application-events.tsv', `${existing.replace(/\s*$/, '')}\n${line}\n`);
  return true;
}

/** Read and parse profile.yml */
export function readProfile(root) {
  return asWorkspace(root).readYaml('config/profile.yml');
}

/** Write profile.yml from JSON object */
export function writeProfile(root, data) {
  asWorkspace(root).writeYaml('config/profile.yml', data);
}

/** Read _profile.md raw content */
export function readProfileMarkdown(root) {
  return asWorkspace(root).read('modes/_profile.md');
}

/** Write _profile.md */
export function writeProfileMarkdown(root, content) {
  asWorkspace(root).write('modes/_profile.md', content);
}

/** Read and parse portals.yml */
export function readPortals(root) {
  return asWorkspace(root).readYaml('portals.yml');
}

/** Write portals.yml from JSON object */
export function writePortals(root, data) {
  asWorkspace(root).writeYaml('portals.yml', data);
}

function cleanCompanyPayload(company) {
  const payload = { ...company };
  if (payload.enabled == null) payload.enabled = true;
  if (payload.provider === 'auto') delete payload.provider;
  for (const key of Object.keys(payload)) {
    const value = payload[key];
    if (value === '' || value == null) delete payload[key];
    if (key === 'provider_config' && typeof value === 'object' && value && Object.keys(value).length === 0) {
      delete payload[key];
    }
  }
  return payload;
}

/** Read portals.yml, mutating the tracked_companies array, then write back. */
function withCompanies(root, fn) {
  const ws = asWorkspace(root);
  const portals = ws.readYaml('portals.yml') || {};
  if (!portals.tracked_companies) portals.tracked_companies = [];
  const result = fn(portals.tracked_companies);
  ws.writeYaml('portals.yml', portals);
  return result;
}

export function addCompany(root, company) {
  return withCompanies(root, companies => {
    companies.push(cleanCompanyPayload(company));
    return true;
  });
}

export function updateCompany(root, existingName, updates) {
  return withCompanies(root, companies => {
    const idx = companies.findIndex(c => c.name.toLowerCase() === existingName.toLowerCase());
    if (idx === -1) return false;
    companies[idx] = cleanCompanyPayload({ ...companies[idx], ...updates });
    return true;
  });
}

export function deleteCompany(root, companyName) {
  return withCompanies(root, companies => {
    const idx = companies.findIndex(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (idx === -1) return false;
    companies.splice(idx, 1);
    return true;
  });
}

/**
 * Merge tracked_companies from templates/portals.example.yml into the
 * user's portals.yml. Skips entries whose name already exists
 * (case-insensitive). New entries always land with `enabled: false` so
 * the user opts in deliberately. Returns { added, skipped, total }.
 */
export function seedImportCompanies(root) {
  const ws = asWorkspace(root);
  const template = ws.readYaml('templates/portals.example.yml');
  if (!template?.tracked_companies?.length) {
    return { added: 0, skipped: 0, total: 0, error: 'Template missing or has no tracked_companies' };
  }
  const portals = ws.readYaml('portals.yml');
  if (!portals) {
    return { added: 0, skipped: 0, total: template.tracked_companies.length, error: 'No portals.yml found' };
  }
  if (!Array.isArray(portals.tracked_companies)) portals.tracked_companies = [];

  const existing = new Set(portals.tracked_companies.map(c => String(c.name || '').toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const candidate of template.tracked_companies) {
    const key = String(candidate?.name || '').toLowerCase();
    if (!key) { skipped += 1; continue; }
    if (existing.has(key)) { skipped += 1; continue; }
    const entry = cleanCompanyPayload({ ...candidate, enabled: false });
    portals.tracked_companies.push(entry);
    existing.add(key);
    added += 1;
  }
  if (added > 0) ws.writeYaml('portals.yml', portals);
  return { added, skipped, total: template.tracked_companies.length };
}

/** Toggle a company's enabled status in portals.yml.
 *
 * W4: when the user manually re-enables a company that was auto-disabled
 * by the health check, reset its failure counter and clear the
 * auto_disabled flag so the next health check doesn't immediately
 * re-disable it. This gives the user a fresh window to fix the
 * underlying URL.
 */
export function toggleCompanyEnabled(root, companyName, enabled) {
  return withCompanies(root, companies => {
    const company = companies.find(c => c.name.toLowerCase() === companyName.toLowerCase());
    if (!company) return false;
    company.enabled = enabled;
    if (enabled && company.auto_disabled) {
      delete company.auto_disabled;
      if (company.health) company.health.consecutive_failures = 0;
    }
    return true;
  });
}

/** Read cv.md */
export function readCV(root) {
  return asWorkspace(root).read('cv.md');
}

/** Write cv.md */
export function writeCV(root, content) {
  asWorkspace(root).write('cv.md', content);
}

/** Update application status in applications.md */
export function updateApplicationStatus(root, reportNumber, rowNum, newStatus, trackerRowId = null) {
  const ws = asWorkspace(root);
  const relPath = ws.exists('data/applications.md') ? 'data/applications.md' : 'applications.md';
  const content = ws.read(relPath);
  if (content == null) return false;

  const lines = content.split('\n');
  let found = false;
  let eventPayload = null;

  const dataLineIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.startsWith('|') && !line.startsWith('| #') && !line.startsWith('|---'))
    .map(({ index }) => index);

  let targetLine = -1;
  let trackerMatches = [];
  if (trackerRowId != null) {
    trackerMatches = dataLineIndexes.filter((index) =>
      lines[index].split('|')[1]?.trim() === String(trackerRowId)
    );
    if (trackerMatches.length === 1) {
      targetLine = trackerMatches[0];
    } else if (trackerMatches.length > 1) {
      const reportMatches = reportNumber
        ? trackerMatches.filter((index) => lines[index].includes(`[${reportNumber}]`))
        : [];
      if (reportMatches.length === 1) {
        targetLine = reportMatches[0];
      } else {
        const parseOrderLine = dataLineIndexes[Number(rowNum) - 1];
        if (trackerMatches.includes(parseOrderLine)) targetLine = parseOrderLine;
      }
    }
  }
  if (targetLine === -1 && reportNumber && (trackerRowId == null || trackerMatches.length === 0)) {
    targetLine = dataLineIndexes.find((index) => lines[index].includes(`[${reportNumber}]`)) ?? -1;
  }
  if (targetLine === -1 && trackerRowId == null && rowNum) {
    targetLine = dataLineIndexes.find((index) =>
      lines[index].split('|')[1]?.trim() === String(rowNum)
    ) ?? -1;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|---')) continue;
    found = i === targetLine;

    if (found) {
      const parts = lines[i].split('|');
      if (parts.length >= 10) {
        const priorStatus = String(parts[6] || '').trim();
        parts[6] = ` ${newStatus} `;
        lines[i] = parts.join('|');
        const eventName = statusToApplicationEvent(newStatus);
        if (eventName && statusToApplicationEvent(priorStatus) !== eventName) {
          eventPayload = {
            trackerRowId: String(parts[1] || '').trim() || trackerRowId || rowNum,
            company: String(parts[3] || '').trim(),
            role: String(parts[4] || '').trim(),
            event: eventName,
          };
        }
      }
      break;
    }
  }

  if (!found) return false;
  ws.write(relPath, lines.join('\n'));
  if (eventPayload) appendApplicationEvent(root, eventPayload);
  return true;
}

function parsePipelineIdentity(line) {
  const match = line.match(/^-\s+\[([ x])\]\s+(https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*(.+)$/);
  if (!match) return null;
  const fields = match[4].split('|').map((field) => field.trim()).filter(Boolean);
  const role = fields[0] || '';
  return {
    done: match[1] === 'x',
    url: match[2].trim(),
    company: match[3].trim(),
    role,
    key: canonicalCompanyRoleKey(match[3], role),
  };
}

export function enforcePipelineConsistency(root) {
  const ws = asWorkspace(root);
  const content = ws.read('data/pipeline.md');
  if (content == null) return { removed: 0, removedBecauseTracked: 0, removedBecauseDuplicatePending: 0 };

  const blockedKeys = new Set(
    parseApplications(root)
      .map((app) => canonicalCompanyRoleKey(app.company, app.role))
      .filter((key) => key && key !== '||')
  );

  const lines = content.split('\n');
  let inProcessed = false;
  for (const line of lines) {
    if (/^##\s+Procesad/i.test(line)) {
      inProcessed = true;
      continue;
    }
    if (inProcessed) continue;
    const item = parsePipelineIdentity(line);
    if (!item || !item.done || !item.key || item.key === '||') continue;
    blockedKeys.add(item.key);
  }

  const seenPendingKeys = new Set();
  let removedBecauseTracked = 0;
  let removedBecauseDuplicatePending = 0;
  inProcessed = false;
  const kept = lines.filter((line) => {
    if (/^##\s+Procesad/i.test(line)) {
      inProcessed = true;
      return true;
    }
    if (inProcessed) return true;

    const item = parsePipelineIdentity(line);
    if (!item || item.done || !item.key || item.key === '||') return true;
    if (blockedKeys.has(item.key)) {
      removedBecauseTracked += 1;
      return false;
    }
    if (seenPendingKeys.has(item.key)) {
      removedBecauseDuplicatePending += 1;
      return false;
    }
    seenPendingKeys.add(item.key);
    return true;
  });

  const removed = removedBecauseTracked + removedBecauseDuplicatePending;
  if (removed > 0) ws.write('data/pipeline.md', kept.join('\n'));
  return { removed, removedBecauseTracked, removedBecauseDuplicatePending };
}

function buildReportLink(reportNumber, reportPath) {
  if (!reportPath) return '';
  const number = String(reportNumber || '').trim() || String(reportPath).match(/(?:^|\/)(\d+)-/)?.[1] || '';
  return number ? `[${number}](${reportPath})` : reportPath;
}

function ensureApplicationsFile(ws, relPath) {
  const existing = ws.read(relPath);
  if (existing != null) return existing;
  const bootstrap = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n';
  ws.write(relPath, bootstrap);
  return bootstrap;
}

function markPipelineDone(ws, url) {
  const pipeContent = ws.read('data/pipeline.md');
  if (pipeContent == null) return;
  const lines = pipeContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(url) && lines[i].includes('- [ ]')) {
      lines[i] = lines[i].replace('- [ ]', '- [x]');
      break;
    }
  }
  ws.write('data/pipeline.md', lines.join('\n'));
}

export function markPipelineTailored(root, {
  url,
  company,
  role,
  reportPath = '',
  reportNumber = '',
  hasPdf = false,
  scoreRaw = '',
} = {}) {
  if (!company || !role) return { success: false, error: 'company and role are required' };
  const ws = asWorkspace(root);
  if (url) markPipelineDone(ws, url);

  const appsRelPath = ws.exists('data/applications.md') ? 'data/applications.md' : 'applications.md';
  const appsContent = ensureApplicationsFile(ws, appsRelPath);
  const lines = appsContent.split('\n');
  const today = new Date().toISOString().slice(0, 10);
  const normalizedKey = canonicalCompanyRoleKey(company, role);
  const reportCell = buildReportLink(reportNumber, reportPath);
  let nextNum = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|') || line.startsWith('| #') || line.startsWith('|---')) continue;
    const parts = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((field) => field.trim());
    if (parts.length < 8) continue;
    const rowNum = parseInt(parts[0], 10);
    if (Number.isFinite(rowNum)) nextNum = Math.max(nextNum, rowNum + 1);
    if (canonicalCompanyRoleKey(parts[2], parts[3]) !== normalizedKey) continue;

    parts[1] = parts[1] || today;
    parts[2] = company;
    parts[3] = role;
    parts[4] = scoreRaw || parts[4] || '';
    const existingStatus = String(parts[5] || '').trim();
    parts[5] = existingStatus && existingStatus.toLowerCase() !== 'tailored' ? existingStatus : 'Tailored';
    parts[6] = hasPdf ? '✅' : (parts[6] || '❌');
    parts[7] = reportCell || parts[7] || '';
    parts[8] = parts[8] || '';
    const finalRowId = parts[0] || rowNum || nextNum;
    lines[i] = `| ${finalRowId} | ${parts[1]} | ${parts[2]} | ${parts[3]} | ${parts[4]} | ${parts[5]} | ${parts[6]} | ${parts[7]} | ${parts[8]} |`;
    ws.write(appsRelPath, lines.join('\n'));
    if (!existingStatus || /tailor|evaluat|hold|monitor|verificar|condicional/i.test(existingStatus)) {
      appendApplicationEvent(root, {
        trackerRowId: finalRowId,
        company: parts[2],
        role: parts[3],
        event: 'tailored',
      });
    }
    return { success: true, updated: true, num: rowNum || nextNum };
  }

  const newRow = `| ${nextNum} | ${today} | ${company} | ${role} | ${scoreRaw} | Tailored | ${hasPdf ? '✅' : '❌'} | ${reportCell} | |`;
  ws.write(appsRelPath, appsContent.trimEnd() + '\n' + newRow + '\n');
  appendApplicationEvent(root, {
    trackerRowId: nextNum,
    company,
    role,
    event: 'tailored',
  });
  return { success: true, updated: false, num: nextNum };
}

/**
 * Delete every pending (unchecked) offer from pipeline.md's Pendientes
 * section. Leaves checked/done items, SKIP rows, EXPIRED rows, and the
 * Procesadas section untouched. Returns the count removed.
 */
export function deleteAllPending(root) {
  const ws = asWorkspace(root);
  const content = ws.read('data/pipeline.md');
  if (content == null) return 0;

  const lines = content.split('\n');
  const kept = [];
  let inProcessed = false;
  let removed = 0;

  for (const line of lines) {
    if (/^##\s+Procesad/i.test(line)) inProcessed = true;
    // Only drop `- [ ] http...` lines in the Pendientes section.
    if (!inProcessed && /^-\s+\[\s\]\s+https?:\/\//.test(line)) {
      removed++;
      continue;
    }
    kept.push(line);
  }

  if (removed > 0) ws.write('data/pipeline.md', kept.join('\n'));
  return removed;
}

/**
 * Delete a specific set of pending offers by URL. Mirrors deleteAllPending
 * but only removes rows whose URL is in `urls`. Checked / skipped /
 * expired rows and the Procesadas section are untouched.
 */
export function deletePendingByUrl(root, urls) {
  if (!Array.isArray(urls) || !urls.length) return 0;
  const wanted = new Set(urls);
  const ws = asWorkspace(root);
  const content = ws.read('data/pipeline.md');
  if (content == null) return 0;

  const lines = content.split('\n');
  const kept = [];
  let inProcessed = false;
  let removed = 0;

  for (const line of lines) {
    if (/^##\s+Procesad/i.test(line)) inProcessed = true;
    if (!inProcessed && /^-\s+\[\s\]\s+https?:\/\//.test(line)) {
      const match = line.match(/https?:\/\/\S+/);
      if (match && wanted.has(match[0])) {
        removed++;
        continue;
      }
    }
    kept.push(line);
  }

  if (removed > 0) ws.write('data/pipeline.md', kept.join('\n'));
  return removed;
}

/**
 * Append a new pending entry to pipeline.md's Pendientes section.
 * Returns { added: bool, duplicate: bool } — duplicate is true when the
 * URL already exists anywhere in pipeline.md (pending, skipped, or
 * processed).
 */
export function addPendingItem(root, { url, company, role, postedAt = null, location = null }) {
  if (!url || !company || !role) return { added: false, duplicate: false };
  const ws = asWorkspace(root);
  let content = ws.read('data/pipeline.md');
  if (content == null) {
    // Bootstrap a minimal pipeline.md if the user has none yet.
    content = '# Pipeline\n\n## Pendientes\n\n## Procesadas\n';
  }

  if (content.includes(url)) return { added: false, duplicate: true };
  const candidateKey = canonicalCompanyRoleKey(company, role);
  const duplicateRole = content.split('\n').some((line) => {
    const item = parsePipelineIdentity(line);
    return item?.key === candidateKey;
  });
  if (duplicateRole) return { added: false, duplicate: true };

  const lines = content.split('\n');
  // Find the Pendientes header so we can insert directly under it. If it's
  // missing for any reason, fall back to inserting before Procesadas.
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Pendientes/i.test(lines[i])) { insertAt = i + 1; break; }
  }
  if (insertAt === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Procesad/i.test(lines[i])) { insertAt = i; break; }
    }
  }
  if (insertAt === -1) insertAt = lines.length;

  // Skip blank lines right after the header so the new entry slots in
  // before existing rows rather than leaving a gap.
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;

  const datePart = postedAt ? ` | posted:${postedAt}` : '';
  // Defensive: strip pipe / newline from location so we don't break the
  // pipe-delimited format. Empty location → omit the field entirely.
  const locClean = location ? String(location).replace(/[\n\r|]/g, '').trim() : '';
  const locPart = locClean ? ` | loc:${locClean}` : '';
  const newLine = `- [ ] ${url} | ${company} | ${role}${datePart}${locPart}`;
  lines.splice(insertAt, 0, newLine);
  ws.write('data/pipeline.md', lines.join('\n'));
  return { added: true, duplicate: false };
}

/**
 * Update a pending (unchecked) pipeline item without losing optional metadata
 * like posted date, location, or match tier. Pass `newUrl` to move the item to
 * a different posting URL; the lookup still uses the original `url`.
 */
export function updatePendingItem(root, { url, company, role, postedAt = null, location = null, newUrl = null } = {}) {
  if (!url || !company || !role) return { updated: false, error: 'url, company, and role are required' };
  const ws = asWorkspace(root);
  const content = ws.read('data/pipeline.md');
  if (content == null) return { updated: false, error: 'pipeline.md not found' };

  const companyClean = String(company).replace(/[\n\r|]/g, '').trim();
  const roleClean = String(role).replace(/[\n\r|]/g, '').trim();
  const postedClean = postedAt ? String(postedAt).replace(/[\n\r|]/g, '').trim() : '';
  const locationClean = location ? String(location).replace(/[\n\r|]/g, '').trim() : '';
  const newUrlClean = newUrl ? String(newUrl).replace(/[\s|\n\r]/g, '').trim() : '';

  if (newUrlClean) {
    if (!/^https?:\/\//i.test(newUrlClean)) return { updated: false, error: 'url must start with http:// or https://' };
    if (newUrlClean !== url) {
      const targetExists = content.split('\n').some(line => {
        const m = line.match(/^-\s+\[\s\]\s+(https?:\/\/\S+)/);
        return m && m[1].trim() === newUrlClean;
      });
      if (targetExists) return { updated: false, error: 'a pending item already exists for that url' };
    }
  }

  const lines = content.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^-\s+\[\s\]\s+(https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*(.+)$/);
    if (!match || match[1].trim() !== url) continue;

    const restFields = match[3].split('|').map(field => field.trim());
    const extras = [];
    for (let j = 1; j < restFields.length; j++) {
      const field = restFields[j];
      if (/^posted:/.test(field)) continue;
      if (/^loc:/.test(field)) continue;
      extras.push(field);
    }

    if (postedClean) extras.unshift(`posted:${postedClean}`);
    if (locationClean) {
      const insertAt = postedClean ? 1 : 0;
      extras.splice(insertAt, 0, `loc:${locationClean}`);
    }

    const effectiveUrl = newUrlClean || url;
    lines[i] = [`- [ ] ${effectiveUrl}`, companyClean, roleClean, ...extras]
      .filter(Boolean)
      .join(' | ');
    found = true;
    break;
  }

  if (!found) return { updated: false, error: 'pending item not found' };
  ws.write('data/pipeline.md', lines.join('\n'));
  return { updated: true };
}

function cleanPipelineField(value, max = 240) {
  return String(value || '').replace(/[\n\r|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function updatePendingContextualScores(root, scores = []) {
  const ws = asWorkspace(root);
  const content = ws.read('data/pipeline.md');
  if (content == null || !Array.isArray(scores) || !scores.length) return { updated: 0 };

  const byUrl = new Map(scores
    .filter(score => score?.id && Number.isFinite(score.score))
    .map(score => [String(score.id), score]));
  if (!byUrl.size) return { updated: 0 };

  let updated = 0;
  const lines = content.split('\n').map((line) => {
    const match = line.match(/^-\s+\[\s\]\s+(https?:\/\/\S+)\s*\|\s*([^|]+)\s*\|\s*(.+)$/);
    if (!match) return line;
    const url = match[1].trim();
    const score = byUrl.get(url);
    if (!score) return line;

    const fields = match[3].split('|').map(field => field.trim());
    const role = fields[0] || '';
    const extras = fields.slice(1).filter(field => !/^(llm|why|signals):/.test(field));
    const llm = Math.max(0, Math.min(5, Number(score.score))).toFixed(1);
    const why = cleanPipelineField(score.rationale, 180);
    const signals = Array.isArray(score.signals)
      ? score.signals.map(signal => cleanPipelineField(signal, 60)).filter(Boolean).slice(0, 4).join(',')
      : '';

    extras.push(`llm:${llm}`);
    if (why) extras.push(`why:${why}`);
    if (signals) extras.push(`signals:${signals}`);
    updated++;
    return [`- [ ] ${url}`, match[2].trim(), role, ...extras].filter(Boolean).join(' | ');
  });

  if (updated > 0) ws.write('data/pipeline.md', lines.join('\n'));
  return { updated };
}

/** Mark a pending offer in pipeline.md with a status (SKIP or EXPIRED) and date */
export function markPipelineItem(root, url, status) {
  const ws = asWorkspace(root);
  const content = ws.read('data/pipeline.md');
  if (content == null) return false;

  const today = new Date().toISOString().slice(0, 10);
  const lines = content.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(url) && lines[i].includes('- [ ]')) {
      lines[i] = lines[i].replace('- [ ]', '- [x]').trimEnd() + ` | ${status} | ${today}`;
      found = true;
      break;
    }
  }

  if (found) ws.write('data/pipeline.md', lines.join('\n'));
  return found;
}

/** Skip a pending offer in pipeline.md */
export function skipPipelineItem(root, url) {
  return markPipelineItem(root, url, 'SKIP');
}

/** Un-skip a pipeline item: revert [x] ... | SKIP back to [ ] pending */
export function unskipPipelineItem(root, url) {
  const ws = asWorkspace(root);
  const content = ws.read('data/pipeline.md');
  if (content == null) return false;

  const lines = content.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(url) && lines[i].includes('- [x]') && lines[i].includes('SKIP')) {
      // Strip the | SKIP | date suffix and revert to pending
      lines[i] = lines[i].replace('- [x]', '- [ ]').replace(/\s*\|\s*SKIP\s*(\|\s*\d{4}-\d{2}-\d{2})?\s*$/, '');
      found = true;
      break;
    }
  }

  if (found) ws.write('data/pipeline.md', lines.join('\n'));
  return found;
}

/** Mark a pending offer as expired in pipeline.md */
export function expirePipelineItem(root, url) {
  return markPipelineItem(root, url, 'EXPIRED');
}

/** Mark a pending offer as applied: mark done in pipeline.md and add to applications.md */
export function markPipelineApplied(root, url, company, role) {
  const ws = asWorkspace(root);

  markPipelineDone(ws, url);

  const existingKey = canonicalCompanyRoleKey(company, role);
  const existing = parseApplications(root).find(app =>
    canonicalCompanyRoleKey(app.company, app.role) === existingKey
  );
  if (existing) {
    updateApplicationStatus(root, existing.reportNumber, existing.num, 'Applied', existing.trackerRowId);
    return;
  }

  // Add to applications.md
  const today = new Date().toISOString().slice(0, 10);
  const appsRelPath = ws.exists('data/applications.md') ? 'data/applications.md' : 'applications.md';
  const appsContent = ensureApplicationsFile(ws, appsRelPath);
  const rows = appsContent.split('\n').filter(l => l.startsWith('|') && !l.startsWith('| #') && !l.startsWith('|---'));
  const nextNum = rows.reduce((max, line) => {
    const rowId = parseInt(line.split('|')[1]?.trim(), 10);
    return Number.isFinite(rowId) ? Math.max(max, rowId) : max;
  }, 0) + 1;

  const newRow = `| ${nextNum} | ${today} | ${company} | ${role} | | Applied | ❌ | | |`;
  ws.write(appsRelPath, appsContent.trimEnd() + '\n' + newRow + '\n');
  appendApplicationEvent(root, {
    trackerRowId: nextNum,
    company,
    role,
    event: 'applied',
  });
}

/**
 * Ensure a template file is copied to destination if destination doesn't exist.
 *
 * Looks for the template inside the workspace first (project-tree / dev mode,
 * where the repo's own templates/ dir is the workspace). If it isn't there —
 * e.g. a freshly scaffolded ~/.catabull home workspace that only carries a
 * subset of templates — fall back to copying it out of `fallbackRoot` (the
 * package root, which always ships the canonical templates).
 */
export function ensureFromTemplate(root, templateRel, destRel, fallbackRoot = null) {
  const ws = asWorkspace(root);
  if (ws.exists(destRel)) return false;
  if (ws.exists(templateRel)) return ws.copy(templateRel, destRel);
  if (fallbackRoot) return asWorkspace(fallbackRoot).copyTo(templateRel, root, destRel);
  return false;
}
