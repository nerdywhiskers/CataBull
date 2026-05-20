#!/usr/bin/env node

/**
 * marketing/preview.mjs — Local preview server for the landing page.
 *
 * Usage: npm run preview   (or: node marketing/preview.mjs)
 *
 * Serves marketing/ on http://localhost:8080 with no caching, so editing
 * a file and hitting reload shows the change immediately. Auto-opens
 * the browser on first run; pass --no-open to suppress.
 *
 * Zero dependencies — pure Node http + fs. No build, no watch script,
 * no installed bytes. Just for previewing during development.
 */

import { createServer } from 'http';
import { readFileSync, statSync } from 'fs';
import { join, extname, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname);
const PORT = Number(process.env.PORT) || 8080;
const OPEN_BROWSER = !process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function safeResolve(urlPath) {
  // Strip query/hash, decode, default to index.html.
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  const candidate = resolve(ROOT, '.' + rel);
  // Path-traversal guard: must stay inside ROOT.
  if (!candidate.startsWith(ROOT)) return null;
  return candidate;
}

const server = createServer((req, res) => {
  const file = safeResolve(req.url || '/');
  if (!file) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  try {
    const stat = statSync(file);
    if (stat.isDirectory()) {
      // Try index.html inside the directory
      const idx = join(file, 'index.html');
      try {
        const data = readFileSync(idx);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(data);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
    }
    const data = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    return res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`Not found: ${req.url}`);
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Error: ${err.message}`);
  }
});

function openInBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Fall through silently — printing the URL is enough.
  }
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  CareerBot landing page preview`);
  console.log(`  Serving:  ${ROOT}`);
  console.log(`  URL:      ${url}`);
  console.log(`  Stop:     Ctrl+C\n`);
  if (OPEN_BROWSER) openInBrowser(url);
});

// Graceful shutdown so Ctrl+C doesn't print a stack trace.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
