/**
 * lib/workspace.mjs — Workspace abstraction.
 *
 * Every read/write of user data (cv.md, profile.yml, portals.yml,
 * applications.md, reports/, output/, etc.) goes through a Workspace.
 *
 * Today the only implementation is LocalWorkspace, which is disk-backed
 * and rooted at a directory on the user's machine. Phase 2 of the
 * product strategy adds an S3-backed implementation for hosted, with the
 * same surface — modes and routes won't have to change.
 *
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  statSync,
} from 'fs';
import { dirname, join, resolve, sep, posix } from 'path';
import yaml from 'js-yaml';

/**
 * Disk-backed workspace. All paths are resolved relative to `root`.
 *
 * Path arguments are workspace-relative (e.g. "cv.md", "data/applications.md").
 * They MAY use forward slashes regardless of platform — we normalize them.
 *
 * `root` is stored as an absolute path; `resolve(relPath)` is the only place
 * that joins them, and it guards against path traversal.
 */
export class LocalWorkspace {
  constructor(root) {
    if (!root) throw new Error('LocalWorkspace requires a root directory');
    this.root = resolve(root);
  }

  /** Absolute filesystem path for a workspace-relative path. */
  resolve(relPath) {
    if (typeof relPath !== 'string' || !relPath) {
      throw new Error(`Workspace path must be a non-empty string, got: ${typeof relPath}`);
    }
    // Normalize forward slashes; strip leading slashes so users can pass
    // "/cv.md" or "cv.md" interchangeably.
    const normalized = relPath.replace(/[\\/]+/g, sep).replace(/^\.?[\\/]/, '');
    const absolute = resolve(this.root, normalized);
    // Guard: the resolved path must stay inside root. Defends against
    // "../../etc/passwd" sneaking in via untrusted relPath.
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep;
    if (absolute !== this.root && !absolute.startsWith(rootWithSep)) {
      throw new Error(`Path escape detected: ${relPath} resolved outside workspace root`);
    }
    return absolute;
  }

  exists(relPath) {
    return existsSync(this.resolve(relPath));
  }

  /** Read a UTF-8 text file. Returns null if missing. */
  read(relPath) {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf-8');
  }

  /** Read a binary file. Returns null if missing. */
  readBuffer(relPath) {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs);
  }

  /** Write content to a file. Creates parent directories as needed. */
  write(relPath, content) {
    const abs = this.resolve(relPath);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(abs, content);
  }

  /** Create a file only when it does not already exist. */
  writeExclusive(relPath, content) {
    const abs = this.resolve(relPath);
    const dir = dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(abs, content, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  }

  /** Read + parse YAML. Returns null on missing file or parse error. */
  readYaml(relPath, { onError } = {}) {
    const text = this.read(relPath);
    if (text == null) return null;
    try {
      return yaml.load(text);
    } catch (error) {
      if (onError) onError(error);
      else console.warn(`Failed to parse ${relPath}: ${error.message}`);
      return null;
    }
  }

  /** Serialize + write YAML. Mirrors the dump options used across the codebase. */
  writeYaml(relPath, data, opts = {}) {
    const dump = yaml.dump(data, {
      lineWidth: -1,
      quotingType: '"',
      forceQuotes: false,
      ...opts,
    });
    this.write(relPath, dump);
  }

  /** Copy from one relative path to another. Returns false if source is missing. */
  copy(srcRel, destRel) {
    return this.copyTo(srcRel, this, destRel);
  }

  /** Copy from this workspace to another workspace. Returns false if source is missing. */
  copyTo(srcRel, destWorkspace, destRel = srcRel) {
    const src = this.resolve(srcRel);
    if (!existsSync(src)) return false;
    const dest = asWorkspace(destWorkspace).resolve(destRel);
    const dir = dirname(dest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    return true;
  }

  /** Delete a file or directory. Returns true if it was removed, false if it didn't exist. */
  delete(relPath) {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) return false;
    rmSync(abs, { recursive: true, force: true });
    return true;
  }

  /** Create a directory (and parents) if it doesn't exist. */
  mkdir(relPath) {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  }

  /** Return a workspace rooted at a child directory of this workspace. */
  child(relPath) {
    return new LocalWorkspace(this.resolve(relPath));
  }

  /**
   * List entries in a directory. Returns an array of objects with
   * { name, isDirectory, isFile }. Returns [] if dir doesn't exist.
   *
   * For glob-style matching, callers pass a filter function.
   */
  list(relDir = '.', { filter } = {}) {
    const abs = this.resolve(relDir);
    if (!existsSync(abs)) return [];
    const entries = readdirSync(abs, { withFileTypes: true });
    const out = entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
    return filter ? out.filter(filter) : out;
  }

  /** stat metadata for a file/dir. Returns null if missing. */
  stat(relPath) {
    const abs = this.resolve(relPath);
    if (!existsSync(abs)) return null;
    return statSync(abs);
  }

  /**
   * Express the workspace's root as a string. Mostly for legacy callers
   * (CLI scripts, agents) that still take raw `root` strings — they can
   * reach in here instead of carrying root and workspace separately.
   *
   * New code should prefer Workspace methods over poking at .root directly.
   */
  toString() {
    return this.root;
  }
}

/**
 * Coerce a value to a Workspace. Accepts an existing Workspace, a root
 * string, or undefined (uses CATABULL_WORKSPACE_ROOT env or process.cwd()).
 *
 * Used at the boundary of legacy code paths that still pass `root` strings.
 * As we migrate callers to pass Workspaces directly, callers stop needing
 * this helper.
 */
export function asWorkspace(rootOrWorkspace) {
  if (rootOrWorkspace instanceof LocalWorkspace) return rootOrWorkspace;
  if (typeof rootOrWorkspace === 'string' && rootOrWorkspace.length > 0) {
    return new LocalWorkspace(rootOrWorkspace);
  }
  if (rootOrWorkspace == null) {
    const envRoot = process.env.CATABULL_WORKSPACE_ROOT;
    return new LocalWorkspace(envRoot || process.cwd());
  }
  throw new Error(`Cannot coerce to Workspace: ${typeof rootOrWorkspace}`);
}

/**
 * Construct the default workspace based on environment. Used by the
 * dashboard server and CLI entrypoints to pick a root in one place.
 *
 * Resolution order:
 *  1. CATABULL_WORKSPACE_ROOT env var (explicit override)
 *  2. The fallback supplied by the caller
 *  3. process.cwd()
 */
export function defaultWorkspace(fallbackRoot) {
  const envRoot = process.env.CATABULL_WORKSPACE_ROOT;
  return new LocalWorkspace(envRoot || fallbackRoot || process.cwd());
}
