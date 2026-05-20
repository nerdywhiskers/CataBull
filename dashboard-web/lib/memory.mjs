import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

const MEMORY_DIR = 'memory';
const INDEX_FILE = 'MEMORY.md';

const FILE_TEMPLATES = {
  'rejection-patterns.md': `# Rejection Patterns

Auditable memory written from pattern analysis and later evaluation loops.
Entries are append-only unless a non-user-edited record is being upserted.
`,
  'archetype-performance.md': `# Archetype Performance

Durable notes about which archetypes convert well, stall, or need reframing.
`,
  'stack-gap-roadmap.md': `# Stack Gap Roadmap

Tracked skill and tooling gaps pulled from repeated negative outcomes.
`,
  'comp-history.md': `# Compensation History

Observed compensation patterns and acceptance signals captured during evaluation.
`,
  'location-decisions.md': `# Location Decisions

Repeated location and geo-policy decisions that affect targeting quality.
`,
  'outreach-effectiveness.md': `# Outreach Effectiveness

Notes about which outreach tones and angles earn replies by segment.
`,
  'interview-feedback.md': `# Interview Feedback

Story-level interview feedback collected after prep and live loops.
`,
  'user-preferences.md': `# User Preferences

Reusable user-facing phrasing and application-answer preferences.
`,
};

const TYPE_TO_FILE = {
  'rejection-pattern': 'rejection-patterns.md',
  'archetype-performance': 'archetype-performance.md',
  'stack-gap-roadmap': 'stack-gap-roadmap.md',
  'comp-history': 'comp-history.md',
  'location-decisions': 'location-decisions.md',
  'outreach-effectiveness': 'outreach-effectiveness.md',
  'interview-feedback': 'interview-feedback.md',
  'user-preferences': 'user-preferences.md',
};

const TYPE_PREFIX = {
  'rejection-pattern': 'rp',
  'archetype-performance': 'ap',
  'stack-gap-roadmap': 'sg',
  'comp-history': 'ch',
  'location-decisions': 'ld',
  'outreach-effectiveness': 'oe',
  'interview-feedback': 'if',
  'user-preferences': 'up',
};

function memoryPath(root, ...parts) {
  return join(root, MEMORY_DIR, ...parts);
}

function normalizeNewlines(value = '') {
  return value.replace(/\r\n/g, '\n');
}

function ensureMemoryDir(root) {
  const dir = memoryPath(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  for (const [filename, content] of Object.entries(FILE_TEMPLATES)) {
    const path = memoryPath(root, filename);
    if (!existsSync(path)) writeFileSync(path, `${content.trim()}\n`, 'utf-8');
  }

  const indexPath = memoryPath(root, INDEX_FILE);
  if (!existsSync(indexPath)) writeFileSync(indexPath, '# Memory Index\n\n_No memory entries yet._\n', 'utf-8');
}

function listMemoryFiles(root) {
  ensureMemoryDir(root);
  const discovered = readdirSync(memoryPath(root))
    .filter(filename => filename.endsWith('.md') && filename !== INDEX_FILE);
  const filenames = [...new Set([...Object.keys(FILE_TEMPLATES), ...discovered])].sort((a, b) => a.localeCompare(b));
  return filenames.map(filename => ({
    filename,
    path: memoryPath(root, filename),
  }));
}

function parseEntryBlock(block, filename) {
  if (!block.startsWith('---\n')) return null;
  const end = block.indexOf('\n---\n', 4);
  if (end === -1) return null;

  const frontmatter = block.slice(4, end);
  const body = block.slice(end + 5).trim();
  const meta = yaml.load(frontmatter) || {};
  if (!meta.id) return null;

  return {
    ...meta,
    body,
    file: filename,
    anchor: meta.id,
    semantic_key: meta.semantic_key || buildSemanticKey(meta),
  };
}

function parseMemoryFile(root, filename) {
  const path = memoryPath(root, filename);
  if (!existsSync(path)) return [];

  const content = normalizeNewlines(readFileSync(path, 'utf-8'));
  const matches = [...content.matchAll(/---\n([\s\S]*?)\n---\n([\s\S]*?)(?=\n---\n|$)/g)];
  return matches
    .map(match => parseEntryBlock(`---\n${match[1]}\n---\n${match[2]}`.trim(), filename))
    .filter(Boolean);
}

function serializeEntry(entry) {
  const meta = { ...entry };
  delete meta.body;
  delete meta.file;
  delete meta.anchor;

  const frontmatter = yaml.dump(meta, {
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
  }).trim();

  return `---
${frontmatter}
---
${(entry.body || '').trim()}
`;
}

function writeMemoryFile(root, filename, entries) {
  const header = FILE_TEMPLATES[filename] || `# ${filename}\n`;
  const serializedEntries = entries.map(serializeEntry).join('\n');
  const content = serializedEntries
    ? `${header.trim()}\n\n${serializedEntries.trim()}\n`
    : `${header.trim()}\n`;
  writeFileSync(memoryPath(root, filename), content, 'utf-8');
}

function toDateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function buildSemanticKey(entry = {}) {
  if (entry.semantic_key) return entry.semantic_key;
  const parts = [entry.type, entry.dimension, entry.value]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  return parts.join(':');
}

function nextId(entries, prefix) {
  let max = 0;
  const regex = new RegExp(`^${prefix}-(\\d+)$`);
  for (const entry of entries) {
    const match = String(entry.id || '').match(regex);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const left = String(b.last_updated || b.first_seen || '');
    const right = String(a.last_updated || a.first_seen || '');
    if (left !== right) return left.localeCompare(right);
    return String(a.id).localeCompare(String(b.id));
  });
}

function readAllEntries(root) {
  return listMemoryFiles(root)
    .flatMap(({ filename }) => parseMemoryFile(root, filename));
}

function findEntry(root, id) {
  for (const { filename } of listMemoryFiles(root)) {
    const entries = parseMemoryFile(root, filename);
    const match = entries.find((entry) => entry.id === id);
    if (match) return { filename, entries, entry: match };
  }
  return null;
}

export function readIndex(root) {
  regenerateIndex(root);
  return readAllEntries(root).map(entry => ({
    id: entry.id,
    name: entry.name,
    type: entry.type,
    confidence: entry.confidence,
    last_updated: entry.last_updated,
    file: entry.file,
    anchor: entry.anchor,
  }));
}

export function query(root, { type, status, since } = {}) {
  let entries = readAllEntries(root);
  if (type) entries = entries.filter(entry => entry.type === type);
  if (status) entries = entries.filter(entry => entry.status === status);
  if (since) {
    const sinceDate = toDateOnly(since);
    entries = entries.filter(entry => String(entry.last_updated || entry.first_seen || '') >= sinceDate);
  }
  return sortEntries(entries);
}

export function readAll(root) {
  return sortEntries(readAllEntries(root));
}

export function readGrouped(root) {
  return listMemoryFiles(root).map(({ filename }) => ({
    filename,
    entries: sortEntries(parseMemoryFile(root, filename)),
  }));
}

export function regenerateIndex(root) {
  ensureMemoryDir(root);
  const entries = sortEntries(readAllEntries(root));
  const lines = entries.length
    ? entries.map(entry => `- [${entry.id}] ${entry.name} - ${entry.type} - ${entry.confidence} - ${entry.last_updated} -> memory/${entry.file}#${entry.anchor}`)
    : ['_No memory entries yet._'];
  writeFileSync(memoryPath(root, INDEX_FILE), `# Memory Index\n\n${lines.join('\n')}\n`, 'utf-8');
}

export function upsert(root, entry) {
  ensureMemoryDir(root);

  const semanticKey = buildSemanticKey(entry);
  if (!semanticKey) throw new Error('Memory upsert requires type, dimension, and value.');

  const filename = TYPE_TO_FILE[entry.type] || entry.file;
  if (!filename) throw new Error(`No memory file mapping for type "${entry.type}".`);

  const entries = parseMemoryFile(root, filename);
  const activeExisting = entries.find(item => item.semantic_key === semanticKey && item.status !== 'superseded');
  const today = toDateOnly(entry.last_updated || new Date());

  if (activeExisting && !activeExisting.user_edited) {
    const updated = entries.map(item => {
      if (item.id !== activeExisting.id) return item;
      return {
        ...item,
        source: entry.source || item.source,
        confidence: entry.confidence || item.confidence,
        occurrences: (Number(item.occurrences) || 1) + 1,
        last_updated: today,
        semantic_key: semanticKey,
        body: item.body || entry.body || '',
      };
    });
    writeMemoryFile(root, filename, updated);
    regenerateIndex(root);
    return updated.find(item => item.id === activeExisting.id);
  }

  const prefix = TYPE_PREFIX[entry.type] || 'mem';
  const newEntry = {
    id: nextId(entries, prefix),
    name: entry.name,
    type: entry.type,
    source: entry.source,
    confidence: entry.confidence || 'observed',
    last_updated: today,
    first_seen: toDateOnly(entry.first_seen || today),
    occurrences: activeExisting ? (Number(activeExisting.occurrences) || 1) + 1 : (Number(entry.occurrences) || 1),
    status: entry.status || 'active',
    user_edited: Boolean(entry.user_edited),
    semantic_key: semanticKey,
    dimension: entry.dimension,
    value: entry.value,
    supersedes: activeExisting?.user_edited ? activeExisting.id : entry.supersedes,
    body: (entry.body || activeExisting?.body || '').trim(),
  };

  writeMemoryFile(root, filename, [...entries, newEntry]);
  regenerateIndex(root);
  return newEntry;
}

export function updateEntry(root, id, updates = {}) {
  ensureMemoryDir(root);
  const found = findEntry(root, id);
  if (!found) return null;

  const today = toDateOnly(new Date());
  const updatedEntries = found.entries.map((entry) => {
    if (entry.id !== id) return entry;
    return {
      ...entry,
      name: updates.name ?? entry.name,
      body: typeof updates.body === 'string' ? updates.body.trim() : entry.body,
      user_edited: true,
      last_updated: today,
    };
  });

  writeMemoryFile(root, found.filename, updatedEntries);
  regenerateIndex(root);
  return updatedEntries.find((entry) => entry.id === id) || null;
}

export function supersedeEntry(root, id) {
  ensureMemoryDir(root);
  const found = findEntry(root, id);
  if (!found) return null;

  const today = toDateOnly(new Date());
  const updatedEntries = found.entries.map((entry) => {
    if (entry.id !== id) return entry;
    return {
      ...entry,
      status: 'superseded',
      last_updated: today,
    };
  });

  writeMemoryFile(root, found.filename, updatedEntries);
  regenerateIndex(root);
  return updatedEntries.find((entry) => entry.id === id) || null;
}
