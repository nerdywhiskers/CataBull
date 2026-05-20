# Mode: scan -- Portal Scanner (Offer Discovery)

Scans configured job portals, filters by title relevance, and adds new offers to the pipeline for later evaluation.

There are two scan flavors. The difference is whether `search_queries` (LinkedIn / Wellfound / RemoteOK / Ladders) get executed:

| Flavor | What runs | When to use |
|---|---|---|
| **Quick Scan** | `node scan.mjs` only — hits Greenhouse/Ashby/Lever APIs and Playwright-fetches `careers_url` for `tracked_companies`. Zero LLM calls. | Daily/automated runs, dashboard "Run scan" button, onboarding initial scan. |
| **Deep Scan** | Quick Scan **plus** Level 3 — WebSearch on every `search_queries` entry with `enabled: true`, then liveness-check the hits with Playwright. | When the user asks for a scan in chat, or whenever they explicitly say "deep scan". |

**You are running a Deep Scan unless the caller said "quick" or this is the scheduler.** Running only `node scan.mjs` and stopping is a Quick Scan — it is NOT a Deep Scan, even if the script returned errors or zero new offers. Skipping Level 3 when a Deep Scan was requested is a bug, not a fallback.

## Configuration

Read `portals.yml` which contains:
- `search_queries`: WebSearch queries with `site:` filters per portal (broad discovery)
- `tracked_companies`: Specific companies with `careers_url` for direct navigation
- `title_filter`: Keywords positive/negative/seniority_boost for title filtering

## Discovery Levels

### Level 1 -- ATS APIs (handled by `node scan.mjs`)

Direct JSON calls to Greenhouse / Ashby / Lever for every entry in `tracked_companies` whose provider resolves. This is the fast path and runs inside the script.

### Level 2 -- Playwright on `careers_url` (handled by `node scan.mjs`)

For tracked companies without a supported ATS API, the script's `webfetch` provider opens `careers_url` in headless Chromium and scrapes job links. Also runs inside the script.

### Level 3 -- WebSearch on `search_queries` (agent only, REQUIRED for Deep Scan)

The `search_queries` block in `portals.yml` contains `site:` queries for LinkedIn, RemoteOK, Wellfound, Ladders, etc. The script does NOT execute these — only the agent does, via `WebSearch` (or your CLI's equivalent web tool).

For each `search_queries` entry where `enabled: true`:
1. Run the query through WebSearch
2. Collect every result URL
3. Filter by title against `title_filter` (same rules as the script)
4. Liveness-check each surviving URL with Playwright (see below) — WebSearch results go stale fast
5. Dedupe against `scan-history.tsv`, `pipeline.md`, `applications.md`
6. Append survivors to `pipeline.md` and `scan-history.tsv` with source = the query name

**Run Level 3 in a subagent / Task tool when available** so the raw search output (often hundreds of URLs) doesn't flood the main context.

## Pre-scan Health Check (recommended)

Before a Deep Scan, run `npm run scan-health` (or POST `/api/v1/health/check`) to surface dead portal URLs, bot-blocked sites, and unsupported ATS platforms ahead of time. The check is zero-token (pure HTTP + Playwright) and writes `data/scan-health.json`. The dashboard Portals page also has a Health tab that runs the same check.

If many companies show `not_found` / `bot_blocked` / `unknown_ats`, fix or disable them in `portals.yml` before burning agent credits on a Deep Scan against a broken portal set.

## Deep Scan Workflow

1. **Run the script first**: `node scan.mjs` (covers Levels 1 + 2). Capture its stdout summary — you'll combine it with Level 3 results.
2. **Then run Level 3**: WebSearch on every enabled `search_queries` entry, in parallel if your tools allow it. Do this even if the script reported zero new offers, errors, or "all 5 portals 404'd". Errors in Levels 1/2 are not a reason to skip Level 3.
3. **Filter, liveness-check, dedupe** the Level 3 hits as described above.
4. **Merge** the Level 3 additions into the same `pipeline.md` "Pendientes" section the script appends to.
5. **Print a combined summary** showing: companies scanned (script), Level 3 queries run, total filtered, total deduped, total new offers (script + Level 3 broken out separately).

## Liveness Check (Level 3 only)

WebSearch results can be stale. Before adding a Level 3 hit to the pipeline, verify with Playwright:
- Navigate to the URL, take snapshot
- **Active**: Job title + description + Apply button visible → keep
- **Expired**: "job no longer available", "position filled", redirect to error page, or only footer/navbar visible → register in `scan-history.tsv` as `skipped_expired` and discard

Levels 1 and 2 are real-time by definition and don't need this check.

## Filter & Dedupe Rules (apply to all levels)

- **Title filter** uses `title_filter.positive` / `negative` from `portals.yml`. At least one positive keyword must appear (case-insensitive); zero negatives.
- **Dedupe** against three sources: `scan-history.tsv` (URL), `applications.md` (company + role), `pipeline.md` (URL).
- For each kept offer: add `- [ ] {url} | {company} | {title} | posted:{date}` under `## Pendientes` in `pipeline.md`, and append `{url}\t{date}\t{source}\t{title}\t{company}\tadded` to `scan-history.tsv`.
- For filtered/duplicate/expired: log to `scan-history.tsv` with status `skipped_title` / `skipped_dup` / `skipped_expired`.

## Output Summary

```
Portal Scan -- {YYYY-MM-DD}
Companies scanned: N
Total jobs found: N
Filtered by title: N removed
Duplicates: N skipped
New offers added: N

  + {company} | {title} | {location}
  ...

Run /careerbot pipeline to evaluate new offers.
```

## careers_url policy

Every company in `tracked_companies` must have `careers_url` — the direct link to their job page. This avoids re-discovering it on every scan.

**RULE: Always use the company's branded careers URL; only fall back to the raw ATS endpoint if the company has no corporate careers page.**

Many companies run on Workday, Greenhouse, or Lever underneath but expose job IDs only through their own domain. Using the raw ATS URL when a branded page exists can produce false 410 errors because the IDs don't match across the two views.

| ✅ Correct (branded) | ❌ Wrong as first choice (raw ATS) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: if you only have the raw ATS URL, navigate to the company's website first and locate its branded careers page. Only use the raw ATS URL if no branded page exists.

**Known platform URL patterns:**
- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** the company's own URL (e.g. `https://openai.com/careers`)

**API/feed patterns by platform:**
- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` doesn't exist for a company:**
1. Try the known platform pattern first
2. If that fails, do a quick WebSearch: `"{company}" careers jobs`
3. Verify with Playwright that the page loads
4. **Save the working URL to portals.yml** for future scans

**If `careers_url` returns 404 or a redirect:**
1. Note it in the scan output summary
2. Try `scan_query` as a fallback
3. Flag for manual update

## Maintaining portals.yml

- **Always save `careers_url`** when adding a new company
- Add new queries as you discover portals or interesting roles
- Disable noisy queries with `enabled: false`
- Adjust title filter keywords as target roles evolve
- Add companies to `tracked_companies` when you want to follow them closely
- Verify `careers_url` periodically — companies change ATS platforms
