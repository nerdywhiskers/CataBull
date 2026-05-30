import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parseApplications, parsePipeline } from '../lib/parsers.mjs';
import { normalizeUrl } from '../../scan/level3.mjs';
import { DEFAULT_MIN_RELEVANCE } from '../../lib/relevance.mjs';
import {
  GLOBAL_WORKSPACE_PREFERENCE_KEY,
  normalizeGlobalWorkspacePreference,
} from '../../lib/workspace-resolver.mjs';
import {
  detectTailscale,
  normalizeTailscaleMode,
  startTailscaleServe,
  stopTailscaleServe,
  tailnetDashboardUrl,
} from '../../lib/tailscale.mjs';

export const SECRET_SETTINGS = [
  { id: 'braveApiKey', envKey: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API key' },
  { id: 'serperApiKey', envKey: 'SERPER_API_KEY', label: 'Serper API key' },
  { id: 'apolloApiKey', envKey: 'APOLLO_API_KEY', label: 'Apollo API key' },
];

const PROVIDER_KEY = 'CATABULL_WEBSEARCH';
const PROVIDERS = new Set(['auto', 'brave', 'scrape', 'serper']);
const WEBSEARCH_ORDER_KEY = 'CATABULL_WEBSEARCH_ORDER';
const DEEP_SCAN_LIMIT_KEY = 'CATABULL_DEEP_SCAN_LIMIT';
const MIN_RELEVANCE_KEY = 'CATABULL_DEEP_SCAN_MIN_RELEVANCE';
const FRESHNESS_DAYS_KEY = 'CATABULL_SCAN_FRESHNESS_DAYS';
const TAILSCALE_MODE_KEY = 'CATABULL_TAILSCALE_MODE';
const AUTO_UPDATE_KEY = 'CATABULL_AUTO_UPDATE';
const DEFAULT_WEBSEARCH_ORDER = 'brave,serper,scrape';
const SCAN_HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n';

export default async function (app) {
  const root = app.cataBullRoot;

  app.get('/settings', async () => readSettings(root));

  app.put('/settings', async (req, reply) => {
    const body = req.body || {};
    const envUpdates = {};
    const globalEnvUpdates = {};
    const currentSettings = readSettings(root);
    const previousTailscaleMode = currentSettings.tailscale?.mode || 'off';

    for (const setting of SECRET_SETTINGS) {
      const clearName = `clear${setting.id[0].toUpperCase()}${setting.id.slice(1)}`;
      if (body[clearName] === true) {
        envUpdates[setting.envKey] = null;
        continue;
      }

      if (typeof body[setting.id] === 'string' && body[setting.id].trim() !== '') {
        const value = sanitizeSecret(body[setting.id]);
        const invalid = validateEnvValue(value);
        if (invalid) {
          return reply.code(400).send({ error: `${setting.label}: ${invalid}` });
        }
        envUpdates[setting.envKey] = value;
      }
    }

    if (typeof body.webSearchProvider === 'string') {
      const provider = normalizeProvider(body.webSearchProvider);
      if (!PROVIDERS.has(provider)) {
        return reply.code(400).send({ error: 'Unsupported WebSearch provider.' });
      }
      envUpdates[PROVIDER_KEY] = provider === 'auto' ? null : provider;
    }

    if (typeof body.webSearchOrder === 'string') {
      const order = normalizeProviderOrder(body.webSearchOrder);
      if (!order) return reply.code(400).send({ error: 'Provider order must include at least one provider.' });
      envUpdates[WEBSEARCH_ORDER_KEY] = order === DEFAULT_WEBSEARCH_ORDER ? null : order;
    }

    if (body.deepScanLimit !== undefined) {
      const value = parseBoundedInteger(body.deepScanLimit, { min: 0, max: 1000 });
      if (value == null) return reply.code(400).send({ error: 'Deep Scan max roles must be between 0 and 1000.' });
      envUpdates[DEEP_SCAN_LIMIT_KEY] = value === 0 ? null : String(value);
    }

    if (body.minRelevance !== undefined) {
      const value = parseBoundedNumber(body.minRelevance, { min: 0, max: 5 });
      if (value == null) return reply.code(400).send({ error: 'Minimum relevance must be between 0 and 5.' });
      envUpdates[MIN_RELEVANCE_KEY] = String(roundToStep(value, 0.5));
    }

    if (body.freshnessDays !== undefined) {
      const value = parseBoundedInteger(body.freshnessDays, { min: 0, max: 365 });
      if (value == null) return reply.code(400).send({ error: 'Freshness window must be between 0 and 365 days.' });
      envUpdates[FRESHNESS_DAYS_KEY] = value === 0 ? null : String(value);
    }

    if (typeof body.tailscaleMode === 'string') {
      const mode = normalizeTailscaleMode(body.tailscaleMode);
      if (mode !== previousTailscaleMode) {
        const action = applyTailscaleMode(mode, previousTailscaleMode, process.env.PORT || 3737);
        if (!action.ok) return reply.code(400).send({ error: action.error });
      }
      envUpdates[TAILSCALE_MODE_KEY] = mode === 'off' ? null : mode;
    }

    if (body.autoUpdate !== undefined) {
      envUpdates[AUTO_UPDATE_KEY] = body.autoUpdate === true ? 'true' : null;
    }

    if (body.workspacePreference !== undefined) {
      const rawPreference = String(body.workspacePreference || '').trim().toLowerCase();
      if (!['home', 'cwd'].includes(rawPreference)) {
        return reply.code(400).send({ error: 'Workspace preference must be home or cwd.' });
      }
      const preference = normalizeGlobalWorkspacePreference(rawPreference);
      globalEnvUpdates[GLOBAL_WORKSPACE_PREFERENCE_KEY] = preference;
    }

    if (Object.keys(envUpdates).length > 0) {
      const envPath = settingsEnvPath(root);
      const current = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      const next = applyEnvUpdates(current, envUpdates);
      writeFileSync(envPath, next, 'utf-8');

      for (const [key, value] of Object.entries(envUpdates)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }

    if (Object.keys(globalEnvUpdates).length > 0) {
      const envPath = globalSettingsEnvPath();
      const current = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      const next = applyEnvUpdates(current, globalEnvUpdates);
      mkdirSync(join(homedir(), '.catabull'), { recursive: true });
      writeFileSync(envPath, next, 'utf-8');
    }

    return { success: true, settings: readSettings(root) };
  });

  app.get('/settings/maintenance', async () => readMaintenanceStatus(root));

  app.post('/settings/maintenance/clear-scan-history', async () => {
    const removed = countScanHistoryRows(root);
    writeScanHistory(root, []);
    return { success: true, removed, maintenance: readMaintenanceStatus(root) };
  });

  app.post('/settings/maintenance/rebuild-scan-history', async () => {
    const rows = buildScanHistoryRows(root);
    writeScanHistory(root, rows);
    return { success: true, rows: rows.length, maintenance: readMaintenanceStatus(root) };
  });
}

export function readSettings(root, runtimeEnv = process.env) {
  const envPath = settingsEnvPath(root);
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const globalEnvPath = globalSettingsEnvPath();
  const globalEnvText = existsSync(globalEnvPath) ? readFileSync(globalEnvPath, 'utf-8') : '';
  return readSettingsFromEnv(text, runtimeEnv, { detectTailnet: true, globalEnvText, root });
}

export function readSettingsFromEnv(text, runtimeEnv = {}, { detectTailnet = false, globalEnvText = '', root = '' } = {}) {
  const secrets = {};
  for (const setting of SECRET_SETTINGS) {
    const fileValue = readEnvValue(text, setting.envKey);
    const runtimeValue = runtimeEnv[setting.envKey];
    const configured = Boolean(fileValue || runtimeValue);
    secrets[setting.id] = {
      label: setting.label,
      envKey: setting.envKey,
      configured,
      redacted: configured ? '********' : '',
      source: fileValue ? '.env' : (runtimeValue ? 'environment' : null),
    };
  }

  const providerValue = readEnvValue(text, PROVIDER_KEY) || runtimeEnv[PROVIDER_KEY] || '';
  const orderValue = readEnvValue(text, WEBSEARCH_ORDER_KEY) || runtimeEnv[WEBSEARCH_ORDER_KEY] || '';
  const minRelevanceValue = readEnvValue(text, MIN_RELEVANCE_KEY) ?? runtimeEnv[MIN_RELEVANCE_KEY];
  const tailscaleMode = normalizeTailscaleMode(readEnvValue(text, TAILSCALE_MODE_KEY) || runtimeEnv[TAILSCALE_MODE_KEY]);
  const autoUpdate = parseEnvBoolean(readEnvValue(text, AUTO_UPDATE_KEY) ?? runtimeEnv[AUTO_UPDATE_KEY]);
  const globalInstallPreference = normalizeGlobalWorkspacePreference(
    readEnvValue(globalEnvText || text, GLOBAL_WORKSPACE_PREFERENCE_KEY) ?? runtimeEnv[GLOBAL_WORKSPACE_PREFERENCE_KEY]
  );
  const tailscaleStatus = detectTailnet
    ? detectTailscale({ env: runtimeEnv })
    : { installed: false, running: false, available: false, ip: '', dnsName: '', message: 'Not checked' };
  return {
    secrets,
    webSearchProvider: normalizeProvider(providerValue),
    webSearchOrder: normalizeProviderOrder(orderValue) || DEFAULT_WEBSEARCH_ORDER,
    scanDefaults: {
      deepScanLimit: parseBoundedInteger(readEnvValue(text, DEEP_SCAN_LIMIT_KEY) ?? runtimeEnv[DEEP_SCAN_LIMIT_KEY], { min: 0, max: 1000 }) ?? 0,
      minRelevance: minRelevanceValue === undefined || minRelevanceValue === ''
        ? DEFAULT_MIN_RELEVANCE
        : (parseBoundedNumber(minRelevanceValue, { min: 0, max: 5 }) ?? DEFAULT_MIN_RELEVANCE),
      freshnessDays: parseBoundedInteger(readEnvValue(text, FRESHNESS_DAYS_KEY) ?? runtimeEnv[FRESHNESS_DAYS_KEY], { min: 0, max: 365 }) ?? 0,
    },
    tailscale: {
      mode: tailscaleMode,
      status: tailscaleStatus,
      url: tailnetDashboardUrl(tailscaleStatus, runtimeEnv.PORT || 3737),
    },
    updates: {
      autoUpdate,
    },
    workspace: {
      globalInstallPreference,
      currentRoot: root || '',
      homeRoot: join(homedir(), '.catabull'),
    },
    envFile: '.env',
  };
}

function applyTailscaleMode(mode, previousMode, dashboardPort) {
  if (mode === 'serve') {
    const status = detectTailscale();
    if (!status.available) {
      return { ok: false, error: `Tailscale is not available: ${status.message}` };
    }
    const started = startTailscaleServe({ dashboardPort });
    if (!started.ok) return { ok: false, error: `Could not start Tailscale Serve: ${started.error}` };
    return { ok: true };
  }

  if (previousMode === 'serve') {
    const status = detectTailscale();
    if (!status.available) return { ok: true };
    const stopped = stopTailscaleServe({ dashboardPort });
    if (!stopped.ok) return { ok: false, error: `Could not stop Tailscale Serve: ${stopped.error}` };
  }

  return { ok: true };
}

export function applyEnvUpdates(text, updates) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const hasFinalNewline = /\r?\n$/.test(text);
  const lines = text ? text.split(/\r?\n/) : [];
  if (hasFinalNewline) lines.pop();

  const updateKeys = new Set(Object.keys(updates));
  const seen = new Set();
  const out = [];

  for (const rawLine of lines) {
    const assignment = parseEnvAssignment(rawLine);
    if (!assignment || !updateKeys.has(assignment.key)) {
      out.push(rawLine);
      continue;
    }

    if (seen.has(assignment.key)) continue;
    seen.add(assignment.key);

    const nextValue = updates[assignment.key];
    if (nextValue == null) continue;
    out.push(`${assignment.key}=${quoteEnvValue(nextValue)}`);
  }

  const additions = [];
  for (const key of updateKeys) {
    if (seen.has(key)) continue;
    const nextValue = updates[key];
    if (nextValue == null) continue;
    additions.push(`${key}=${quoteEnvValue(nextValue)}`);
  }

  if (additions.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(...additions);
  }

  return out.length ? `${out.join(eol)}${eol}` : '';
}

export function readEnvValue(text, wantedKey) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const assignment = parseEnvAssignment(rawLine);
    if (assignment?.key === wantedKey) return assignment.value;
  }
  return undefined;
}

function settingsEnvPath(root) {
  return join(root, '.env');
}

function globalSettingsEnvPath() {
  return join(homedir(), '.catabull', '.env');
}

function sanitizeSecret(value) {
  return String(value || '').trim();
}

function validateEnvValue(value) {
  if (/[\r\n]/.test(value)) return 'must be a single line';
  if (value.length > 2048) return 'is too long';
  return null;
}

function parseEnvAssignment(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line || line.startsWith('#')) return null;
  const eq = line.indexOf('=');
  if (eq < 1) return null;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = line.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  } else {
    const hashIdx = value.indexOf(' #');
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
  }
  return { key, value };
}

function quoteEnvValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider) return 'auto';
  if (provider === 'ddg') return 'scrape';
  return provider;
}

function normalizeProviderOrder(value) {
  const raw = String(value || DEFAULT_WEBSEARCH_ORDER)
    .split(',')
    .map((p) => normalizeProvider(p))
    .filter((p) => p && p !== 'auto');
  const seen = new Set();
  const order = [];
  for (const provider of raw) {
    if (!PROVIDERS.has(provider) || provider === 'auto' || seen.has(provider)) continue;
    seen.add(provider);
    order.push(provider);
  }
  if (order.length === 0) return '';
  return order.join(',');
}

function parseEnvBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parseBoundedInteger(value, { min, max }) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function parseBoundedNumber(value, { min, max }) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function roundToStep(value, step) {
  return Math.round(Number(value) / step) * step;
}

function readMaintenanceStatus(root) {
  const { pending } = parsePipeline(root);
  const applications = parseApplications(root);
  return {
    pendingCount: pending.length,
    scanHistoryRows: countScanHistoryRows(root),
    applicationUrlCount: applications.filter((a) => a.jobUrl).length,
  };
}

function countScanHistoryRows(root) {
  const path = join(root, 'data', 'scan-history.tsv');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('http'))
    .length;
}

function buildScanHistoryRows(root) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  const seen = new Set();
  const add = ({ url, firstSeen, portal, title, company, status }) => {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rows.push({
      url: normalized,
      firstSeen: cleanField(firstSeen || today),
      portal: cleanField(portal || 'settings'),
      title: cleanField(title || ''),
      company: cleanField(company || ''),
      status: cleanField(status || 'known'),
    });
  };

  const { pending, skipped, expired } = parsePipeline(root);
  for (const item of pending) {
    add({ url: item.url, firstSeen: item.postedAt || today, portal: 'pipeline', title: item.role, company: item.company, status: 'pending' });
  }
  for (const item of skipped) {
    add({ url: item.url, firstSeen: item.postedAt || item.date || today, portal: 'pipeline', title: item.role, company: item.company, status: 'skipped' });
  }
  for (const item of expired) {
    add({ url: item.url, firstSeen: item.postedAt || item.date || today, portal: 'pipeline', title: item.role, company: item.company, status: 'expired' });
  }

  for (const app of parseApplications(root)) {
    add({ url: app.jobUrl, firstSeen: app.date || today, portal: 'applications', title: app.role, company: app.company, status: app.status || 'application' });
  }

  return rows;
}

function writeScanHistory(root, rows) {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const body = rows.map((row) =>
    `${row.url}\t${row.firstSeen}\t${row.portal}\t${row.title}\t${row.company}\t${row.status}`
  ).join('\n');
  writeFileSync(join(dataDir, 'scan-history.tsv'), `${SCAN_HISTORY_HEADER}${body ? `${body}\n` : ''}`, 'utf-8');
}

function cleanField(value) {
  return String(value || '').replace(/[\t\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
}
