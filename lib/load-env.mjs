/**
 * lib/load-env.mjs — Minimal .env loader.
 *
 * Reads KEY=VALUE pairs from a `.env` file in the workspace root and
 * sets them on `process.env`, but never overwrites an already-set var
 * (the actual shell env always wins, so deploy/CI overrides keep
 * working).
 *
 * We rolled our own because:
 *   - Node's built-in `--env-file` flag is 20.6+; we support 18+.
 *   - Adding `dotenv` is ~50 KB of dependency for ~20 LOC of work.
 *
 * Supports:
 *   - `KEY=value` lines
 *   - Single/double-quoted values: `KEY="value"`, `KEY='value'`
 *   - `# comment` lines and trailing comments on unquoted values
 *   - Blank lines
 *
 * Not supported (intentionally — keep it small): variable interpolation,
 * multiline values, JSON values, export prefixes.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function loadEnvFile(root) {
  const path = join(root, '.env');
  if (!existsSync(path)) return { loaded: 0, path };
  const text = readFileSync(path, 'utf-8');
  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Quoted value — strip the surrounding quotes, preserve everything inside.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Unquoted value — strip trailing inline comment if present.
      const hashIdx = value.indexOf(' #');
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded++;
    }
  }
  return { loaded, path };
}
