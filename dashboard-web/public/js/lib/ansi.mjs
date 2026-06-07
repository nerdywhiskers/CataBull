const CSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC_REGEX = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const SINGLE_ESCAPE_REGEX = /\x1b[@-Z\\-_]/g;
const PERMISSION_REGEX = /permission[ _]?request|approval\s+(?:required|needed)|requires?\s+approval|\bapprove\b|\(y\/n\)|\by\/n\b|allow this|proceed\?/i;

export function stripAnsi(value = '') {
  return value
    .replace(OSC_REGEX, '')
    .replace(CSI_REGEX, '')
    .replace(SINGLE_ESCAPE_REGEX, '');
}

export function normalizeComparable(value = '') {
  return stripAnsi(value)
    .replace(/^[>\]$#❯]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isPermissionLine(value = '') {
  return PERMISSION_REGEX.test(stripAnsi(value));
}

export function createAnsiLineParser(onLine) {
  let currentLine = '';

  function flushLine() {
    const line = currentLine.trimEnd();
    currentLine = '';
    if (line) onLine(line);
  }

  return {
    push(chunk = '') {
      const clean = stripAnsi(chunk);
      for (const char of clean) {
        if (char === '\r') {
          currentLine = '';
          continue;
        }
        if (char === '\n') {
          flushLine();
          continue;
        }
        if (char === '\b') {
          currentLine = currentLine.slice(0, -1);
          continue;
        }
        if (char < ' ' && char !== '\t') {
          continue;
        }
        currentLine += char;
      }
    },
    flush() {
      flushLine();
    },
    reset() {
      currentLine = '';
    },
  };
}
