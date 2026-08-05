# Tailor/report idempotency implementation plan

**Branch:** `fix/tailor-report-idempotency`  
**Base:** `fix/identity-state-integrity` (PR #79)

## Invariants

1. One canonical company/role owns at most one active report binding.
2. Concurrent or retried `/tailor` requests for that role resolve to one operation and one report.
3. Existing complete bundles are reused unless regeneration is explicitly forced.
4. Missing tracker/report binding may be repaired without allocating duplicate reports.
5. Evaluation owns scoring/report creation; the `/tailor` service exclusively owns tailored artifacts.
6. New bundles write canonical `cv.md`; readers also recognize legacy `tailored-cv.md`.

## Task 1 — Shared bundle compatibility

- Extract report-to-bundle inference into one shared helper.
- Recognize both `cv.md` and legacy `tailored-cv.md` as the CV artifact.
- Keep `cv.md` canonical for new writes.
- Add parser/report-export regression coverage.

## Task 2 — Idempotent tailoring coordinator

- Add a testable server-side coordinator keyed by shared `canonicalCompanyRoleKey`.
- Coalesce in-flight same-role requests.
- Reuse tracker-bound complete bundles on ordinary retries.
- Allow explicit forced regeneration while retaining the same report.
- Append/replace the tailored section in an existing role-bound report.
- Serialize report creation across roles; make exclusive report-file creation retry collisions.
- Bind report and tracker state before releasing the role operation.
- Add regressions for aliases, retries, missing bundle/report state, concurrent same-role calls, concurrent cross-role report allocation, and forced refresh.

## Task 3 — One generation owner

- Remove tailored-artifact generation instructions from evaluation mode/shared evaluation rules.
- Keep evaluation responsible for score/report/tracker data.
- Keep dashboard evaluation flows calling `/tailor` exactly once after evaluation.
- Keep direct Tailor flows calling only `/tailor`.
- Add frontend contract tests proving no hidden duplicate `/tailor` call or generation instruction remains.

## Task 4 — Verification and delivery

- Run focused tailor, parser, report, pipeline, and frontend suites.
- Run `npm test` and omitted smoke/security suites in isolated workspace where required.
- Run syntax checks and `git diff --check`.
- Independent review; repair blockers.
- Push stacked branch and open PR targeting `fix/identity-state-integrity`.
