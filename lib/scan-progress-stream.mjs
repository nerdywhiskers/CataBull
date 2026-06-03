export const SCAN_PROGRESS_PREFIX = '@@SCAN_PROGRESS@@';

export function encodeScanProgress(payload = {}) {
  return `${SCAN_PROGRESS_PREFIX}${JSON.stringify(payload)}`;
}

export function parseProgressLine(line = '') {
  const text = String(line || '');
  if (!text.startsWith(SCAN_PROGRESS_PREFIX)) return null;
  try {
    return JSON.parse(text.slice(SCAN_PROGRESS_PREFIX.length));
  } catch {
    return null;
  }
}

export function createLineBuffer(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) onLine(String(line || '').replace(/\r$/, ''));
  };
}
