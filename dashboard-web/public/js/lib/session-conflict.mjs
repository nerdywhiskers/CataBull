// Detection for the "another process is using this session" error class.
// Returned by claude (and on rare occasions by opencode/codex) when our
// chat panel tries to drive a --session-id / --session uuid that another
// process is currently holding — typically the user's IDE Claude Code
// instance or a parallel `claude -p` job in another terminal.
//
// chat.mjs uses this to detect the error and retry once with a freshly
// rotated uuid. The user loses cross-message continuity for that single
// turn but the chat keeps working instead of dead-ending.
//
// Defensive matching across phrasings — claude's wording has shifted
// across releases. Better to over-match (auto-retry on a lookalike error)
// than to miss the case (user sees the error and gives up).

export const SESSION_CONFLICT_RE = new RegExp(
  [
    // "session is already in use" / "session is in use" / "session locked" / "session is busy"
    /session\s+(?:is\s+)?(?:already\s+|currently\s+)?(?:in\s+use|locked|running|active|busy)/.source,
    // "Another claude process is using this session" / "another instance is on this session"
    /another\s+(?:[a-z]+\s+)*(?:process|instance|client|session|run)\s+(?:is\s+)?(?:using|holding|on|locking)\s+(?:this\s+|the\s+)?session/.source,
    // "Could not acquire/lock session"
    /could\s+not\s+(?:acquire|lock|claim)\s+(?:the\s+)?session/.source,
    // Generic "concurrent session" mention
    /concurrent\s+session/.source,
  ].join('|'),
  'i',
);

export function isSessionConflict(errorMessage) {
  return SESSION_CONFLICT_RE.test(String(errorMessage || ''));
}
