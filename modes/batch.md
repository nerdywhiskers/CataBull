# Mode: batch -- Batch Processing of Offers

Two usage modes: **conductor --chrome** (navigates portals in real-time) or **standalone** (script for pre-collected URLs).

## Architecture

```
Claude Conductor (claude --chrome --dangerously-skip-permissions)
  |
  |  Chrome: navigates portals (logged-in sessions)
  |  Reads DOM directly, user sees everything in real-time
  |
  +- Offer 1: read JD from DOM + URL
  |    +-> claude -p worker -> report .md + PDF + tracker-line
  |
  +- Offer 2: click next, read JD + URL
  |    +-> claude -p worker -> report .md + PDF + tracker-line
  |
  +- Done: merge tracker-additions -> applications.md + summary
```

Each worker is a `claude -p` child with a clean 200K token context. The conductor only orchestrates.

## Files

```
batch/
  batch-input.tsv               # URLs (from conductor or manual)
  batch-state.tsv               # Progress (auto-generated, gitignored)
  batch-runner.sh               # Standalone orchestrator script
  batch-prompt.md               # Prompt template for workers
  logs/                         # One log per offer (gitignored)
  tracker-additions/            # Tracker lines (gitignored)
```

## Mode A: Conductor --chrome

1. **Read state**: `batch/batch-state.tsv` to know what's already processed
2. **Navigate portal**: Chrome to search URL
3. **Extract URLs**: Read DOM results, extract URL list, append to `batch-input.tsv`
4. **For each pending URL**:
   a. Chrome: click the offer, read JD text from DOM
   b. Save JD to `/tmp/batch-jd-{id}.txt`
   c. Calculate next sequential REPORT_NUM
   d. Execute via Bash:
      ```bash
      claude -p --dangerously-skip-permissions \
        --append-system-prompt-file batch/batch-prompt.md \
        "Process this offer. URL: {url}. JD: /tmp/batch-jd-{id}.txt. Report: {num}. ID: {id}"
      ```
   e. Update `batch-state.tsv` (completed/failed + score + report_num)
   f. Log to `logs/{report_num}-{id}.log`
   g. Chrome: go back, next offer
5. **Pagination**: If no more offers, click "Next", repeat
6. **Done**: Merge `tracker-additions/` to `applications.md` + summary

## Mode B: Standalone Script

```bash
batch/batch-runner.sh [OPTIONS]
```

Options:
- `--dry-run` list pending without executing
- `--retry-failed` only retry failed ones
- `--start-from N` start from ID N
- `--parallel N` N workers in parallel
- `--max-retries N` attempts per offer (default: 2)

## batch-state.tsv Format

```
id	url	status	started_at	completed_at	report_num	score	error	retries
1	https://...	completed	2026-...	2026-...	002	4.2	-	0
2	https://...	failed	2026-...	2026-...	-	-	Error msg	1
3	https://...	pending	-	-	-	-	-	0
```

## Resumability

- If it dies, re-run. Reads `batch-state.tsv`, skips completed ones
- Lock file (`batch-runner.pid`) prevents double execution
- Each worker is independent: failure in offer #47 doesn't affect the rest

## Workers (claude -p)

Each worker receives `batch-prompt.md` as system prompt. Self-contained.

The worker produces:
1. Report `.md` in `reports/`
2. PDF in `output/`
3. Tracker line in `batch/tracker-additions/{id}.tsv`
4. JSON result on stdout

## Error Handling

| Error | Recovery |
|-------|----------|
| URL inaccessible | Worker fails, conductor marks `failed`, next |
| JD behind login | Conductor tries to read DOM. If fails, `failed` |
| Portal changes layout | Conductor reasons about HTML, adapts |
| Worker crashes | Conductor marks `failed`, next. Retry with `--retry-failed` |
| Conductor dies | Re-run, reads state, skips completed |
| PDF fails | Report .md saved. PDF stays pending |
