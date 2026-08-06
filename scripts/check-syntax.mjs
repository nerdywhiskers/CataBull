#!/usr/bin/env node

import { readdirSync, statSync } from 'fs';
import { dirname, extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['bin', 'dashboard-web', 'lib', 'scan', 'scripts', 'tests'];
const files = readdirSync(root)
  .filter((name) => name.endsWith('.mjs') || name.endsWith('.py'))
  .map((name) => resolve(root, name));

function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if (entry.isFile() && ['.mjs', '.py'].includes(extname(entry.name))) files.push(child);
  }
}
for (const rel of sourceRoots) {
  const path = resolve(root, rel);
  if (statSync(path).isDirectory()) collect(path);
}

let failed = 0;
for (const file of files.sort()) {
  const isPython = extname(file) === '.py';
  const command = isPython ? (process.env.PYTHON || 'python3') : process.execPath;
  const args = isPython
    ? ['-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); compile(p.read_text(encoding="utf-8"), str(p), "exec")', file]
    : ['--check', file];
  const result = spawnSync(command, args, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
  if (result.status === 0) continue;
  failed++;
  process.stderr.write(`${file}\n${result.stderr || result.stdout}`);
}

console.log(`Syntax checked: ${files.length} files`);
if (failed) {
  console.error(`Syntax failures: ${failed}`);
  process.exit(1);
}
