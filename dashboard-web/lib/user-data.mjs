import { asWorkspace } from '../../lib/workspace.mjs';
import { readProfile } from './writers.mjs';

// Everything a user accumulates during onboarding and normal use.
// Keep this in one place so delete/reset, profile switching, and future
// backup-style flows treat the user data layer consistently.
//
// NOTE on `output/` — the directory holds two distinct kinds of files:
//   1. User-content artifacts (tailored CV bundles in tailor-bundles/)
//      → these ARE per-profile user data; they move on profile switch.
//   2. Agent runtime caches (output/opencode-xdg-{config,data,state}/)
//      → these are per-machine runtime state set by opencodeEnv() in
//        agents.mjs. They contain a live SQLite db (opencode.db) that
//        is OPEN whenever OpenCode is running, so trying to unlink the
//        whole `output/` tree on Windows hits EBUSY and 500s the
//        new-profile + delete-profile flows.
// We only list user-content subdirs here. The OpenCode XDG dirs stay
// put across profile switches — they're a runtime detail, not user
// identity. Stronger per-profile agent isolation can be added later
// if the workflow demands it.
export const USER_PATHS = [
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'portals.yml',
  'article-digest.md',
  'data/applications.md',
  'data/pipeline.md',
  'data/scan-history.tsv',
  'data/scan-schedule-state.json',
  'data/scan-health.json',
  'data/scan-health.log',
  'data/follow-ups.md',
  'data/outreach',
  'reports',
  'output/tailor-bundles',
  'interview-prep',
];

const STORE_DIR = '.profiles';
const ACTIVE_FILE = 'active.json';
const MANIFEST_FILE = 'manifest.json';
// Synthetic id for the live/active user layer when it has no archived snapshot
// yet (single-profile install). Lets the switcher always show the current
// profile instead of "No saved profiles yet". Reserved — never written to
// active.json or created under .profiles/.
export const CURRENT_PROFILE_ID = 'current';

function rootWorkspace(root) {
  return asWorkspace(root);
}

function profileWorkspace(root, id = '') {
  return asWorkspace(root).child(`${STORE_DIR}${id ? `/${id}` : ''}`);
}

export function profilesRoot(root) {
  return profileWorkspace(root).root;
}

export function activeProfilePath(root) {
  return profileWorkspace(root).resolve(ACTIVE_FILE);
}

export function slugifyProfileId(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'profile';
}

export function assertSafeProfileId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id || ''))) {
    const err = new Error('Invalid profile id');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

function readJson(workspace, relPath, fallback = null) {
  const text = workspace.read(relPath);
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function writeJson(workspace, relPath, data) {
  workspace.write(relPath, `${JSON.stringify(data, null, 2)}\n`);
}

function candidateLabel(root) {
  const profile = readProfile(root);
  return profile?.candidate?.full_name || profile?.candidate?.email || 'Untitled profile';
}

function nextAvailableId(root, baseId) {
  const profiles = profileWorkspace(root);
  let id = assertSafeProfileId(baseId);
  let n = 2;
  while (profiles.exists(id)) {
    id = `${baseId.slice(0, 58)}-${n++}`;
  }
  return id;
}

export function getActiveProfileId(root) {
  return readJson(profileWorkspace(root), ACTIVE_FILE, {})?.id || null;
}

export function setActiveProfileId(root, id) {
  writeJson(profileWorkspace(root), ACTIVE_FILE, { id: id || null, updated_at: new Date().toISOString() });
}

export function listProfiles(root) {
  const profiles = profileWorkspace(root);
  const activeId = getActiveProfileId(root);
  const stored = profiles.list('.')
    .filter(d => d.isDirectory)
    .map(d => {
      const id = d.name;
      const manifest = readJson(profiles.child(id), MANIFEST_FILE, {});
      return {
        id,
        label: manifest.label || id,
        created_at: manifest.created_at || null,
        updated_at: manifest.updated_at || null,
        active: id === activeId,
      };
    })
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  // Surface the live/active user layer as a synthetic "current" entry when it
  // isn't already represented by a stored snapshot. Snapshots only get created
  // once the user makes a second profile (New profile / Switch archives the
  // current one); until then the active profile lives only in the root layer,
  // so the switcher would otherwise read "No saved profiles yet" even though a
  // profile exists.
  const activeRepresented = activeId && stored.some(p => p.id === activeId);
  const hasCurrentId = stored.some(p => p.id === CURRENT_PROFILE_ID);
  const hasActiveData = USER_PATHS.some(rel => rootWorkspace(root).exists(rel));
  if (!activeRepresented && !hasCurrentId && hasActiveData) {
    stored.unshift({
      id: CURRENT_PROFILE_ID,
      label: candidateLabel(root),
      created_at: null,
      updated_at: null,
      active: true,
      current: true,
    });
  }
  return stored;
}

export function removeActiveUserData(root) {
  const workspace = rootWorkspace(root);
  const removed = [];
  for (const rel of USER_PATHS) {
    if (!workspace.exists(rel)) continue;
    workspace.delete(rel);
    removed.push(rel);
  }
  return removed;
}

function copyUserData(root, destRoot) {
  const source = rootWorkspace(root);
  const dest = rootWorkspace(destRoot);
  const copied = [];
  for (const rel of USER_PATHS) {
    if (!source.exists(rel)) continue;
    source.copyTo(rel, dest, rel);
    copied.push(rel);
  }
  return copied;
}

export function archiveActiveProfile(root, { id, label } = {}) {
  const workspace = rootWorkspace(root);
  const copiedProbe = USER_PATHS.some(rel => workspace.exists(rel));
  if (!copiedProbe) return null;

  const activeId = getActiveProfileId(root);
  const baseId = slugifyProfileId(id || activeId || label || candidateLabel(root));
  const profileId = activeId || (id ? assertSafeProfileId(baseId) : nextAvailableId(root, baseId));
  const profileStore = profileWorkspace(root, profileId);
  profileStore.mkdir('.');

  const existing = readJson(profileStore, MANIFEST_FILE, {});
  const now = new Date().toISOString();
  const copied = copyUserData(root, profileStore.root);
  const manifest = {
    id: profileId,
    label: label || existing.label || candidateLabel(root),
    created_at: existing.created_at || now,
    updated_at: now,
    paths: copied,
  };
  writeJson(profileStore, MANIFEST_FILE, manifest);
  setActiveProfileId(root, profileId);
  return manifest;
}

export function restoreProfile(root, id) {
  assertSafeProfileId(id);
  const source = profileWorkspace(root, id);
  const manifest = readJson(source, MANIFEST_FILE);
  if (!manifest) {
    const err = new Error('Profile not found');
    err.statusCode = 404;
    throw err;
  }

  const dest = rootWorkspace(root);
  removeActiveUserData(root);
  for (const rel of USER_PATHS) {
    if (!source.exists(rel)) continue;
    source.copyTo(rel, dest, rel);
  }
  setActiveProfileId(root, id);
  return manifest;
}

export function deleteStoredProfile(root, id) {
  assertSafeProfileId(id);
  const profiles = profileWorkspace(root);
  if (!profiles.exists(id)) return false;
  profiles.delete(id);
  if (getActiveProfileId(root) === id) setActiveProfileId(root, null);
  return true;
}
