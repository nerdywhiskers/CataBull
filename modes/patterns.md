# Mode: patterns -- Rejection Pattern Detector

## Purpose

Analyze all tracked applications to find patterns in outcomes and surface actionable insights. Identify what is working, such as archetypes, remote policies, and score ranges, and what is wasting time, such as geo-restricted roles, stack mismatches, or low-score applications.

## Inputs

- `data/applications.md` -- Application tracker
- `reports/` -- Individual evaluation reports
- `config/profile.yml` -- User profile for recommendation context
- `modes/_profile.md` -- User archetypes and framing
- `portals.yml` -- Portal config for filter update recommendations
- `memory/` -- Existing learned memory for dedupe and upserts

## Minimum Threshold

Before running analysis, check whether `data/applications.md` has at least 5 entries with status beyond `Tailored`:

- `Applied`
- `Responded`
- `Interview`
- `Offer`
- `Rejected`
- `Discarded`
- `SKIP`

If not, tell the user:

> "Not enough data yet -- {N}/5 applications have progressed beyond evaluation. Keep applying and come back when you have more outcomes to analyze."

Exit gracefully.

## Step 1 -- Run Analysis Script

Execute:

```bash
node analyze-patterns.mjs
```

Parse the JSON output. It contains:

| Key | Contents |
|-----|----------|
| `metadata` | Total entries, date range, analysis date, counts by outcome |
| `funnel` | Count per status stage |
| `scoreComparison` | Avg/min/max score per outcome group |
| `archetypeBreakdown` | Per-archetype totals and conversion rate |
| `blockerAnalysis` | Most frequent hard blockers |
| `remotePolicy` | Per-policy totals and conversion rate |
| `companySizeBreakdown` | Startup, scaleup, enterprise |
| `scoreThreshold` | Recommended minimum score and reasoning |
| `techStackGaps` | Most frequent tech gaps in negative outcomes |
| `recommendations` | Top 5 actionable items with impact level |

If the script returns `error`, display the error message and exit.

## Step 2 -- Generate Report

Write the report to `reports/pattern-analysis-{YYYY-MM-DD}.md`.

### Report Structure

```markdown
# Pattern Analysis -- {YYYY-MM-DD}

**Applications analyzed:** {total}
**Date range:** {from} to {to}
**Outcomes:** {positive} positive, {negative} negative, {self_filtered} self-filtered, {pending} pending

---

## Conversion Funnel

| Stage | Count | % |
|-------|-------|---|
| Tailored | X | X% |
| Applied | X | X% |

## Score vs Outcome

| Outcome | Avg Score | Min | Max | Count |
|---------|-----------|-----|-----|-------|
| Positive | X.X/5 | X.X | X.X | X |

## Archetype Performance

Table with each archetype, total applications, positive outcomes, and conversion rate.
Highlight the best-performing archetype and the worst.

## Top Blockers

Frequency table of recurring hard blockers.

## Remote Policy Patterns

Conversion rate by remote policy bucket.

## Tech Stack Gaps

Most common missing skills in negative or self-filtered outcomes.

## Recommended Score Threshold

State the data-driven minimum score and reasoning.

## Recommendations

1. **[IMPACT]** Action to take
   Reasoning behind the recommendation.
```

## Step 3 -- Present Summary

Show the user a condensed version with:

1. One-line stat summary
2. Top 3 findings
3. Link to the full report

Example:

> **Pattern Analysis Complete** (24 applications, Apr 7-8)
>
> Key findings:
> - Geo-restricted roles are 0% conversion (7 of 24) -- stop evaluating US/Canada-only postings
> - Regional/global remote roles convert at 57-67% -- these are your sweet spot
> - No positive outcomes below 4.2/5 -- consider this your score floor
>
> Full report: `reports/pattern-analysis-2026-04-08.md`

## Step 4 -- Identify Durable Signals

Before asking the user to change anything, identify which findings are durable enough to become memory:

- rejection patterns that appeared 2+ times
- archetype performance signals backed by multiple outcomes
- stack or tooling gaps that recur across negative or self-filtered outcomes

For each durable signal, capture:

- `name`
- `type` (`rejection-pattern`, `archetype-performance`, `stack-gap-roadmap`)
- `dimension` and `value` for the semantic key
- `confidence` (`observed` if it came directly from repeated outcomes, `inferred` if it is a synthesis)
- `source` pointing to the report you just wrote
- concise body text with the recommendation

## Step 5 -- Offer to Apply Recommendations

Ask the user if they want to act on any recommendations:

> "Want me to apply any of these recommendations? I can:
> - Update `portals.yml` to filter out geo-restricted roles
> - Set a score threshold in `_profile.md` for PDF generation
> - Adjust archetype targeting based on what's converting
>
> Just say which ones, or 'all' to apply everything."

If the user agrees:

- For portal filter changes: edit `portals.yml`
- For profile or archetype changes: edit `modes/_profile.md` and never `_shared.md`
- For score threshold: add to `config/profile.yml` under a `patterns` key

## Step 6 -- Persist Findings

In addition to the report, upsert durable findings into:

- `memory/rejection-patterns.md`
- `memory/archetype-performance.md`
- `memory/stack-gap-roadmap.md`

Use the helper in `dashboard-web/lib/memory.mjs`.

Rules:

- Upsert by semantic key `{type}:{dimension}:{value}`
- Never overwrite the body of an existing non-user-edited entry, only bump `occurrences` and `last_updated`
- If an existing entry has `user_edited: true`, create a new entry with `supersedes: <old-id>` instead of editing it
- Always include `source:` on every memory write
- After writing, regenerate `memory/MEMORY.md`

## Outcome Classification

For reference, outcomes are classified as:

| Status | Outcome |
|--------|---------|
| Interview, Offer, Responded, Applied | **Positive** |
| Rejected, Discarded | **Negative** |
| SKIP, NO APLICAR | **Self-filtered** |
| Tailored | **Pending** |
