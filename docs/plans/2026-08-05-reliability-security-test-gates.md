# Reliability, security, and test-gates implementation plan

**Branch:** `fix/reliability-security-test-gates`
**Base:** `fix/tailor-report-idempotency` (PR #80)

## Confirmed baselines

- Scheduler state writes `data/scan-schedule-state.json` without creating `data/`, producing `ENOENT` in a fresh workspace.
- Bulk health disconnect cleanup closes `recoverProc` but can leave the later `applyProc` running.
- At least one GET/read route performs consistency writes; reads must not silently mutate workspace state.
- `npm run test:unit` stops at a stale OpenCode PTY assertion (`71/72` in `tests/test-chat-session.mjs`).
- `npm test` omits frontend smoke and security regression suites.
- `npm audit --omit=dev` reports three high vulnerabilities:
  - `@fastify/static <=10.1.1` path/route-guard bypasses;
  - `brace-expansion 5.0.8` allocation DoS;
  - `fast-uri 3.1.4` host confusion.

## Invariants

1. Workspace replacement writes are atomic: create sibling temporary file, then rename.
2. Fresh workspaces may persist scheduler state without pre-created directories.
3. Client disconnect terminates whichever bulk-health child is active and cleanup is idempotent.
4. GET/read routes do not write tracker or pipeline state.
5. Production dependency audit has zero high/critical advisories.
6. Agent PTY expectations match current documented argv behavior.
7. One documented comprehensive test command runs unit, integration, frontend smoke, and security regression coverage.
8. Every confirmed defect gets a failing regression before implementation.

## Work units

### 1. Atomic workspace and scheduler persistence

- Add regressions for atomic replacement and fresh-root scheduler writes.
- Make `LocalWorkspace.write()` use sibling temporary-file plus rename semantics.
- Move or wrap scheduler state persistence so parent creation and atomic replacement are guaranteed.
- Verify cleanup leaves no temporary files after success or failure.

### 2. Process lifecycle and read-only GET behavior

- Add a bulk-health disconnect regression covering both recovery and apply phases.
- Centralize active-child cleanup; terminate the active process once and clear in-flight state in `finally`.
- Identify each GET-side consistency write with a before/after filesystem regression.
- Remove mutation from reads; keep repair/reconciliation on explicit write routes or startup maintenance paths.

### 3. Dependency security

- Upgrade `@fastify/static` to a compatible patched release.
- Refresh lockfile resolution for patched `brace-expansion` and `fast-uri` versions; use overrides only if upstream ranges cannot resolve safely.
- Run auth, static-serving, security, frontend, and full tests after upgrades.
- Require `npm audit --omit=dev` to report zero high/critical findings.

### 4. Test-contract repair and comprehensive gate

- Reproduce and align the stale OpenCode PTY assertion with `agentPtyConfig` behavior.
- Add explicit scripts for lightweight, unit, smoke, security, and comprehensive gates without recursive npm-script loops.
- Ensure the comprehensive command includes frontend smoke and security regression tests in isolated workspaces.
- Add syntax/static checks appropriate to the mixed JS/Python repository without introducing a broad formatting rewrite.

### 5. Final verification and publication

- Run targeted regressions after each work unit.
- Run full comprehensive gate, production audit, syntax checks, and `git diff --check`.
- Obtain independent read-only review.
- Push and open a stacked PR targeting `fix/tailor-report-idempotency`.
- Do not merge any PR in the stack.
