/**
 * focus.mjs — preserve input focus + cursor position across container
 * re-renders.
 *
 * Search inputs in the pipeline, discover, and portals views all live
 * inside containers whose entire innerHTML is replaced on every input
 * event. The native HTMLInputElement is destroyed and a fresh one
 * takes its place — without help, focus + selection don't survive
 * the swap, so the user can only type one character before having to
 * click the input again.
 *
 * Wrap the update call with `preserveFocus(container, () => update(container))`
 * and the helper captures the active element's id + selection range
 * beforehand, then re-finds the recreated element by id afterwards and
 * restores both focus and cursor position.
 *
 * Only elements that:
 *   - are currently focused
 *   - live inside `container`
 *   - have an `id` attribute
 * are eligible. Caret-less inputs (radio, checkbox) skip the selection
 * restore but still get refocused.
 */

export function preserveFocus(container, fn) {
  const active = document.activeElement;
  const eligible = active && active !== document.body && container.contains(active) && active.id;
  let snapshot = null;
  if (eligible) {
    snapshot = { id: active.id };
    // Not every focusable element has selectionStart (e.g. <select>,
    // checkboxes). Capture only when present.
    if (active.selectionStart != null) {
      snapshot.selectionStart = active.selectionStart;
      snapshot.selectionEnd = active.selectionEnd;
      snapshot.selectionDirection = active.selectionDirection || 'none';
    }
  }

  fn();

  if (!snapshot) return;
  // CSS.escape() guards against ids with quirky characters; legit ids
  // in this codebase are alphanum + dashes, but cheap to be safe.
  const restored = container.querySelector(`#${CSS.escape(snapshot.id)}`);
  if (!restored) return;
  try { restored.focus({ preventScroll: true }); } catch { restored.focus(); }
  if (snapshot.selectionStart != null && typeof restored.setSelectionRange === 'function') {
    try {
      restored.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection);
    } catch { /* selection on an unsupported input type — ignore */ }
  }
}
