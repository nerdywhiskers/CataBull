# Mode: followup -- Follow-up Cadence Tracker

Read `modes/humanizer.md` before writing any follow-up drafts.

## Purpose

Track follow-up cadence for active applications. Flag overdue follow-ups, extract contacts from notes, and generate tailored follow-up email/LinkedIn drafts using report context.

## Inputs

- `data/applications.md` -- Application tracker
- `data/follow-ups.md` -- Follow-up history (created on first use)
- `reports/` -- Evaluation reports (for context in drafts)
- `config/profile.yml` -- User profile (name, identity)
- `cv.md` -- CV for proof points in drafts

## Step 1 -- Run Cadence Script

Execute:

```bash
node followup-cadence.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Analysis date, total tracked, actionable count, overdue/urgent/cold/waiting counts |
| `entries` | Per-application: company, role, status, days since application, follow-up count, urgency, next follow-up date, extracted contacts, report path |
| `cadenceConfig` | Cadence rules (applied: 7 days, responded: 3 days, interview: 1 day) |

If no actionable entries, tell the user:
> "No active applications to follow up on. Apply to some roles first and come back when they're aging."

## Step 2 -- Display Dashboard

Show a cadence dashboard sorted by urgency (urgent > overdue > waiting > cold):

```
Follow-up Cadence Dashboard -- {date}
{N} applications tracked, {N} actionable

| # | Company | Role | Status | Days | Follow-ups | Next | Urgency | Contact |
```

Use visual indicators:
- **URGENT** respond within 24 hours (company replied)
- **OVERDUE** follow-up is past due
- **waiting (X days)** on track, follow-up scheduled
- **COLD** 2+ follow-ups sent, suggest closing

## Step 3 -- Generate Follow-up Drafts

For each **overdue** or **urgent** entry only:

1. Read the linked report (`reportPath` from JSON) for company context
2. Read `cv.md` for proof points
3. Read `config/profile.yml` for candidate name and identity

### Email Follow-up Framework (first follow-up, followupCount == 0)

Generate a 3-4 sentence email:

1. **Sentence 1:** Reference the specific role + when you applied
2. **Sentence 2:** One concrete value-add from the report or a proof point from cv.md. Quantify if possible
3. **Sentence 3:** Soft ask + availability. Offer a specific time window
4. **Sentence 4 (optional):** Brief mention of a relevant recent project or achievement

**Rules:**
- Professional but warm, NOT desperate
- **NEVER** use "just checking in", "just following up", "touching base", or "circling back"
- Lead with value, not with the ask
- Reference something specific to THAT company (from the report)
- Keep under 150 words
- Include a subject line

### LinkedIn Follow-up (if no email contact found)

Use the outreach framework: 3 sentences, 300 character max.
- Hook specific to company, then proof point, then soft ask
- Suggest the user run `/catabull outreach {company}` to find the right person first

### Second Follow-up (followupCount == 1)

Shorter than first (2-3 sentences). Take a **new angle**:
- Share a relevant insight, article, or project update
- Don't repeat the first follow-up's content
- Still reference the role specifically

### Cold Application (followupCount >= 2)

Do NOT generate another follow-up. Instead suggest:
> "This application has had {N} follow-ups with no response. Consider:
> - Updating status to Discarded if the role seems filled
> - Trying a different contact via /catabull outreach
> - Keeping in Applied status but deprioritizing"

## Step 4 -- Record Follow-ups

After the user reviews and confirms they've sent a follow-up, record it:

1. If `data/follow-ups.md` doesn't exist, create it with a header table
2. Append a row with: sequential number, app number, date, company, role, channel, contact, notes
3. Optionally update the Notes column in `data/applications.md`

**IMPORTANT:** Only record follow-ups the user confirms they actually sent.

## Step 5 -- Write Memory (max 1 entry)

If a follow-up produces a clear reusable lesson about tone, channel, or timing, upsert one entry into `memory/outreach-effectiveness.md`.

Examples:
- concise value-led email works better than generic check-in language
- recruiter email performs better than LinkedIn for a specific segment
- second follow-up with a fresh proof point gets better traction than a reminder-only message

Only persist durable signals, always include `source:`, and never overwrite `user_edited: true` memory.

## Cadence Rules Reference

| Status | First follow-up | Subsequent | Max attempts |
|--------|----------------|------------|-------------|
| Applied | 7 days after application | Every 7 days | 2 (then mark cold) |
| Responded | 1 day (urgent reply) | Every 3 days | No limit |
| Interview | 1 day after (thank-you) | Every 3 days | No limit |
