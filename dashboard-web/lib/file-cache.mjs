import { existsSync, readFileSync, statSync } from 'fs';

// Memoize parsed file contents keyed on absolute path + mtime. The first call
// reads + parses; subsequent calls return the cached result until the file is
// modified on disk, at which point statSync's mtimeMs flips and we reparse.
//
// Used by the portals page where the same scan-history.tsv + pipeline.md were
// being re-parsed once per tracked company on every page load. Cache hits cost
// a single statSync call (~µs) instead of a multi-MB readFile + parse.
//
// Caveats:
//   - In-process only. A second worker process won't share the cache, but we
//     don't run multiple workers in this dashboard.
//   - mtime resolution is filesystem-dependent. NTFS gives ms precision, which
//     is fine for human-edited files. If a script writes the file twice in the
//     same ms, the second write may not invalidate. Acceptable for our use.
//   - If the file is deleted, returns the parser's empty result and clears the
//     cached entry so a recreated file isn't masked.

const cache = new Map();

export function cachedRead(absPath, parser) {
  if (!existsSync(absPath)) {
    cache.delete(absPath);
    return parser('');
  }
  const mtime = statSync(absPath).mtimeMs;
  const hit = cache.get(absPath);
  if (hit && hit.mtime === mtime) return hit.value;
  const raw = readFileSync(absPath, 'utf-8');
  const value = parser(raw);
  cache.set(absPath, { mtime, value });
  return value;
}

// Test helper — drop everything. Not used in production paths.
export function clearFileCache() {
  cache.clear();
}
