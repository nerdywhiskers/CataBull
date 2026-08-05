# Identity and State Integrity Repair Plan

> **For Hermes:** Implement task-by-task with strict RED-GREEN-REFACTOR.

**Goal:** Stop duplicate role creation, wrong-row status updates, duplicate tracker IDs, and status/tab drift.

**Architecture:** Use one canonical company-role identity function for all JavaScript tracker and pipeline writers. Keep URL as source metadata, not primary role identity. Treat `Tailored` as the canonical pre-application state from `templates/states.yml`, while preserving `Evaluated` as a read alias. Make stable tracker row IDs authoritative for updates.

**Tech Stack:** Node.js ESM, Python importer, Markdown-backed workspace, existing script-style test harness.

---

### Task 1: Stable tracker status updates and row IDs

**Files:**
- Modify: `tests/test-pipeline-writers.mjs`
- Modify: `dashboard-web/lib/writers.mjs`

**Steps:**
1. Add regressions for duplicate report numbers with a supplied tracker row ID and for non-contiguous row IDs.
2. Run `node tests/test-pipeline-writers.mjs`; verify failures.
3. Prefer tracker row ID over report number and allocate `max(row ID) + 1`.
4. Re-run test; verify pass.

### Task 2: Canonical role identity in JS writers and merge/dedup scripts

**Files:**
- Create: `lib/role-identity.mjs`
- Modify: `dashboard-web/lib/writers.mjs`
- Modify: `scripts/merge-tracker.mjs`
- Modify: `scripts/dedup-tracker.mjs`
- Modify: `tests/test-pipeline-writers.mjs`
- Modify: `tests/test-merge-tracker.mjs`

**Steps:**
1. Add regressions for same role/different URL, company suffix variants, single-word roles, and duplicate additions within one merge run.
2. Run targeted tests; verify failures.
3. Move canonical key implementation into shared module and use it at every JS insertion/merge/dedup boundary.
4. Update accepted additions in the in-memory merge index immediately.
5. Re-run targeted tests; verify pass.

### Task 3: Python LinkedIn importer identity consistency

**Files:**
- Modify: `scripts/import-linkedin-junk.py`
- Modify: `tests/test_linkedin_import.py`

**Steps:**
1. Add failing tests for same company/role under different URLs and suffix variants.
2. Run `python3 tests/test_linkedin_import.py`; verify failures.
3. Add equivalent canonical company-role key and dedupe incoming plus existing rows.
4. Re-run test; verify pass.

### Task 4: Canonical status contract and complete tabs

**Files:**
- Modify: `scripts/normalize-statuses.mjs`
- Modify: `scripts/merge-tracker.mjs`
- Modify: `scripts/dedup-tracker.mjs`
- Modify: `dashboard-web/public/js/views/pipeline.mjs`
- Modify: `tests/test-core.mjs`
- Modify: `tests/test-merge-tracker.mjs`
- Modify: `tests/test-pipeline-actions.mjs`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Steps:**
1. Add contract regressions proving writers emit `Tailored`, `Evaluated` remains a read alias, and every canonical dashboard state has a tab.
2. Run targeted tests; verify failures.
3. Align scripts/docs/UI with `templates/states.yml`; add Responded, Offer, and Discarded tabs.
4. Re-run targeted tests; verify pass.

### Task 5: Verification and PR

1. Run targeted suites.
2. Run `npm test` and `npm run test:unit`; distinguish pre-existing OpenCode assertion drift if still present.
3. Run syntax checks and `git diff --check`.
4. Request independent code review and fix blockers.
5. Commit, push, open PR against `dev`, and inspect CI.
