# Mode: pipeline -- URL Inbox

Processes accumulated offer URLs from `data/pipeline.md`. The user adds URLs whenever they want and then runs `/catabull pipeline` to process them all.

## Workflow

1. **Read** `data/pipeline.md`, find `- [ ]` items in the "Pendientes" section
2. **For each pending URL**:
   a. Calculate next sequential `REPORT_NUM` (read `reports/`, take highest number + 1)
   b. **Extract JD** using Playwright (browser_navigate + browser_snapshot), WebFetch, or WebSearch
   c. If the URL is inaccessible, mark as `- [!]` with a note and continue
   d. **Run full auto-pipeline**: Evaluation A-F, Report .md, PDF (if score >= 3.0), Tracker
   e. **Move from "Pendientes" to "Procesadas"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF`
3. **If there are 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) for speed.
4. **When done**, show summary table:

```
| # | Company | Role | Score | PDF | Recommended Action |
```

## pipeline.md Format

```markdown
## Pendientes
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job -- Error: login required

## Procesadas
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | No PDF
```

## Smart JD Extraction from URL

1. **Playwright (preferred):** `browser_navigate` + `browser_snapshot`. Works with all SPAs.
2. **WebFetch (fallback):** For static pages or when Playwright is unavailable.
3. **WebSearch (last resort):** Search on secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login. Mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly with Read tool
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` reads `jds/linkedin-pm-ai.md`

## Auto-numbering

1. List all files in `reports/`
2. Extract the number prefix (e.g., `142-medispend...` = 142)
3. New number = max found + 1

## Source Sync

Before processing any URL, verify sync:
```bash
node cv-sync-check.mjs
```
If out of sync, warn the user before continuing.
