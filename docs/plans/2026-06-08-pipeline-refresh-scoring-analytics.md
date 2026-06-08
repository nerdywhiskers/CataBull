# Pipeline Refresh, Scoring, Tailoring, Chat Session, and Analytics Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix stale pending-role cleanup, restore consistent LLM scoring across Deep Scan / Pipeline / manual adds, tighten tailoring rules, fix chat session/view drift, and move reports into a first-class Analytics subtab with better report lifecycle UX.

**Architecture:** Keep this as a set of small root-cause fixes, not one giant rewrite. Reuse existing dashboard contracts where they are already close: `/applications`, `/applications/contextual-scores`, `/liveness/check-all`, `/reports`, and the chat record/session model. Extract shared pipeline scoring/report helpers where needed so Discover and Pipeline stop diverging.

**Tech Stack:** Fastify routes (`dashboard-web/routes/*.mjs`), vanilla JS views (`dashboard-web/public/js/views/*.mjs`), shared browser helpers (`dashboard-web/public/js/lib/*.mjs`), parser/metrics/writer helpers (`dashboard-web/lib/*.mjs`), Node test scripts in `tests/*.mjs`.

---

## Findings from current code

1. **Pending refresh stale-role bug**
   - Current auto/manual refresh path is `pipeline.mjs` / `discover.mjs` -> `pending-refresh.mjs` -> `POST /api/v1/liveness/check-all`.
   - Route only expires rows when result is exactly `expired` or `closed` (`dashboard-web/routes/actions.mjs:229-234`).
   - If Playwright or parser returns `uncertain`, stale rows remain forever.
   - Need to inspect whether bad rows are caused by: weak parser phrases, Playwright blocked/interstitial pages, or cleanup policy that never ages out uncertain rows.

2. **LLM scoring fragmentation**
   - Discover already has contextual scoring UI + loading state + `POST /applications/contextual-scores` (`discover.mjs`, `applications.mjs`).
   - Pipeline still renders only heuristic `relevance`; no loading ring, no rescore button, no score-source state.
   - Deep Scan refreshes data when scan completes, but does not automatically kick contextual scoring in Pipeline.
   - Manual add route writes pending rows but does not request contextual scoring (`applications.mjs:142-186`).

3. **Tailor flow mismatch**
   - Pending “Tailor” button still launches `runModePrompt('evaluate', ...)` (`pipeline.mjs:1698-1722`) instead of using the real `/tailor` bundle route.
   - `/tailor` already creates CV + cover letter + Q&A bundle, but current Pipeline UX does not enforce score-threshold behavior or show low-score warnings.
   - Current evaluated-row PDF gating uses `score >= 4.5`; requested behavior is CV + cover letter generation for score > 3.

4. **Chat session drift**
   - Chat records and sticky agent sessions are both stored in localStorage (`chat.mjs`), but current view/session selection can let transcript state and live terminal session drift apart.
   - Need to unify selected record, selected agent, and continuation session ownership when switching views or records.

5. **Analytics / reports UX debt**
   - Analytics page already shows interview rate from computed metrics (`metrics.mjs`) but reports are embedded at bottom of Analytics overview (`progress.mjs:319-388`) while standalone `reports.mjs` also exists.
   - Router currently aliases `#/reports` to Analytics (`app.mjs:119,136`) so existing links can be preserved while moving reports into their own Analytics subtab.
   - Report APIs are read-only today; archive/export/search/nav metadata still missing.

---

## Execution order

1. Liveness refresh root-cause fix first.
2. Shared scoring fixes second.
3. Tailor threshold + bundle wiring third.
4. Chat session alignment fourth.
5. Analytics / reports restructure last.

This order minimizes rework because scoring/tailor/report changes all depend on cleaner pending/evaluated state.

---

## Task 1: Fix stale pending-role cleanup rules

**Objective:** Make Refresh reliably remove clearly dead roles while keeping fresh blocked/login-wall cases safe.

**Files:**
- Modify: `dashboard-web/routes/actions.mjs`
- Modify: `lib/liveness-core.mjs`
- Modify: `scripts/check-liveness.mjs` if result detail needs more signal
- Modify: `dashboard-web/lib/parsers.mjs` only if pipeline row metadata is needed for age-gating
- Test: `tests/test-liveness-core.mjs`
- Test: `tests/test-pipeline-actions.mjs` or new focused route test if needed

**Implementation notes:**
- Document current ruleset in code comments and verify live behavior from `check-all` route.
- Expand closed/filled phrase coverage in `classifyLiveness()` for explicit “filled”, “expired”, and “no longer open” variants that should be hard-expired.
- Preserve blocked/login-wall/challenge responses as `uncertain`, but add enough detail/reason classification so `check-all` can apply a safe fallback policy.
- Add age-gated cleanup in `/liveness/check-all` for old pending rows whose uncertain reason is clearly barrier/interstitial-based.
- Use `postedAt` when present; if absent, consider fallback to first-seen from `data/scan-history.tsv` instead of guessing.
- Return richer summary counts so UI can later explain what happened (expired, blocked-aged-out, uncertain-kept).

**Verification:**
- Run: `node tests/test-liveness-core.mjs`
- Run: `node tests/test-pipeline-actions.mjs`
- Manual: refresh should expire explicit filled/closed fixtures; login-wall fixtures should stay uncertain unless old enough for fallback.

---

## Task 2: Unify pending-role scoring state across Discover, Pipeline, Deep Scan, and manual adds

**Objective:** Pending roles should show consistent match state everywhere, including loading, LLM-complete, and manual rescore behavior.

**Files:**
- Modify: `dashboard-web/public/js/views/discover.mjs`
- Modify: `dashboard-web/public/js/views/pipeline.mjs`
- Modify: `dashboard-web/public/js/api.mjs`
- Modify: `dashboard-web/routes/applications.mjs`
- Create or modify shared helper: `dashboard-web/public/js/lib/*` for pending contextual scoring state if extraction reduces duplication
- Test: `tests/test-contextual-scoring.mjs`
- Test: add focused UI-state/unit test if feasible

**Implementation notes:**
- Extract shared pending contextual scoring workflow from Discover into a reusable helper or keep one source of truth in Pipeline and Discover.
- Pipeline pending table should support:
  - LLM loading animation for unscored rows
  - persistent distinction between heuristic score and LLM score
  - “rescore” action for rows missed during discover/deep-scan
- Deep Scan completion path should refresh pending rows, then kick contextual scoring for unscored rows.
- Manual add should trigger contextual scoring after successful add (client-side is simplest unless server-side persistence becomes necessary).
- Refresh should **not** force LLM rescore for rows already scored by LLM.
- Bring Discover match slider / threshold control into Pipeline using shared UI logic so score filtering stops diverging.
- Fix slider visual/input bug while moving control.

**Verification:**
- Run: `node tests/test-contextual-scoring.mjs`
- Run: `node tests/test-pending-refresh.mjs`
- Run: `node tests/test-discover.mjs`
- Manual: deep scan finish -> pending rows show spinner -> settle to LLM scores; manual add -> spinner -> score; refresh keeps existing LLM scores intact; rescore button updates only requested row(s).

---

## Task 3: Rewire Tailor to real tailor-bundle behavior and enforce score thresholds

**Objective:** Tailor should use actual tailor bundle generation, auto-generate CV + cover letter for scores above 3, and warn on low-fit attempts.

**Files:**
- Modify: `dashboard-web/public/js/views/pipeline.mjs`
- Modify: `dashboard-web/routes/tailor.mjs`
- Modify: `dashboard-web/public/js/api.mjs` if extra metadata is returned
- Modify: `dashboard-web/lib/parsers.mjs` and/or report summary helpers if evaluation needs to expose artifact links consistently
- Test: `tests/test-tailor.mjs`

**Implementation notes:**
- Replace pending “Tailor” button’s evaluate-mode shortcut with a scored flow:
  1. ensure role has current score (LLM if available, heuristic fallback only when unavoidable)
  2. if score < 3.0, show warning modal
  3. if score > 3.0, run `/tailor`
- For evaluated roles above 3, expose generated CV + cover letter links in the report/evaluation UI.
- Decide whether “always generate” means immediately after evaluation completes or on Tailor click for all >3 roles; implement the less risky flow first if current evaluator pipeline does not already call `/tailor`.
- Keep duplicate-tailor confirmation for already-generated bundles.

**Verification:**
- Run: `node tests/test-tailor.mjs`
- Manual: low-score tailor attempt warns; >3 tailor creates CV + cover letter bundle and shows download links.

---

## Task 4: Fix chat terminal/chat-tab session alignment

**Objective:** Active transcript, selected chat record, current agent, and sticky session id should stay in sync.

**Files:**
- Modify: `dashboard-web/public/js/views/chat.mjs`
- Modify: `dashboard-web/public/js/views/chatui.mjs`
- Modify: `dashboard-web/public/js/lib/session-conflict.mjs` only if needed
- Test: `tests/test-chat-session.mjs`

**Implementation notes:**
- Audit transitions: load agents, select saved record, switch agent, start new chat, reconnect websocket, change view between raw terminal/chat.
- Ensure each chat record owns the agent + continuation session it was created with.
- Prevent switching display tabs from silently attaching transcript A to session B.
- Keep current session-conflict auto-recovery behavior intact.

**Verification:**
- Run: `node tests/test-chat-session.mjs`
- Manual: open prior session, switch tab, reconnect, send follow-up, confirm same transcript stays attached to same agent session.

---

## Task 5: Move reports into Analytics subtab and add report lifecycle UX

**Objective:** Reports become a dedicated Analytics subtab without breaking existing deep links, while Analytics gains better funnel outcomes and report management.

**Files:**
- Modify: `dashboard-web/public/js/views/progress.mjs`
- Modify: `dashboard-web/public/js/views/reports.mjs`
- Modify: `dashboard-web/public/js/app.mjs`
- Modify: `dashboard-web/routes/reports.mjs`
- Modify: `dashboard-web/routes/metrics.mjs`
- Modify: `dashboard-web/lib/metrics.mjs`
- Possibly create archive/export helpers under `dashboard-web/lib/*`
- Test: add or update focused metrics/report tests

**Implementation notes:**
- Add Analytics subtabs: `overview`, `reports`, `memory`.
- Preserve `#/reports` and `#/reports/:filename` by routing them to `#/analytics/reports` equivalents.
- Add report search box and standardized cards/list view.
- Add archive action with warning modal; archive should preserve file access or move to an archive location without breaking old references.
- Add export bundle action for report + CV + cover letter.
- Standardize report header with jump links to CV, cover letter, exit story, and proof points sections plus download links.
- Expand metrics cards to show rejection count explicitly and keep/verify interview rate.

**Verification:**
- Run targeted metrics/report tests
- Run: `node tests/test-frontend-smoke.mjs`
- Manual: old `#/reports/...` links still open correct report; Analytics shows Reports tab; search/archive/export work.

---

## Task 6: Final integration pass and PR prep

**Objective:** Verify end-to-end behavior and prepare a clean PR.

**Files:**
- No planned code-only target; use repo-wide verification and docs touchups as needed.

**Verification commands:**
- `node tests/test-liveness-core.mjs`
- `node tests/test-pipeline-actions.mjs`
- `node tests/test-pending-refresh.mjs`
- `node tests/test-contextual-scoring.mjs`
- `node tests/test-tailor.mjs`
- `node tests/test-chat-session.mjs`
- `node tests/test-discover.mjs`
- `node tests/test-frontend-smoke.mjs`
- `npm run test:unit`

**PR scope rules:**
- One feature branch: `feat/pipeline-refresh-scoring-analytics`
- Commit in small slices by task
- Open PR against repo base branch after verification

---

## Risks / watchpoints

1. Pipeline and Discover currently duplicate pending-role UI logic; partial fixes will regress one view.
2. Liveness cleanup can be destructive. Bias toward conservative expiration unless the signal is explicit or age-gated.
3. Auto-tailoring every >3 evaluation may be expensive if triggered too eagerly from scan flows; wire carefully.
4. Reports move can break hashes if router aliases are incomplete.
5. Chat session bugs often look fixed until reconnect/switch-agent paths are exercised.
