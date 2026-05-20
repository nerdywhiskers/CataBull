# Mode: auto-pipeline -- Full Automatic Pipeline

When the user pastes a JD (text or URL) without an explicit sub-command, run the ENTIRE pipeline in sequence:

## Step 0 -- Extract JD

If the input is a **URL** (not pasted JD text), use this strategy to extract the content:

**Priority order:**

1. **Playwright (preferred):** Most job portals (Lever, Ashby, Greenhouse, Workday) are SPAs. Use `browser_navigate` + `browser_snapshot` to render and read the JD.
2. **WebFetch (fallback):** For static pages (ZipRecruiter, company career pages).
3. **WebSearch (last resort):** Search for the role title + company on secondary portals that index the JD in static HTML.

**If nothing works:** Ask the candidate to paste the JD manually or share a screenshot.

**If the input is JD text** (not a URL): use it directly.

## Step 1 -- Evaluation A-G
Run exactly as the `evaluate` mode (read `modes/_shared.md` for all scoring blocks A-F + Block G Posting Legitimacy).

Before scoring, query `memory/` for active entries in:
- `rejection-patterns.md`
- `archetype-performance.md`
- `location-decisions.md`

Emit a `## Memory Signals` block before scoring:
- Only use entries with `status: active`
- `confidence: observed` entries with `occurrences >= 3` may apply a soft score nudge, capped at `-0.3` total
- `confidence: inferred` entries are capped at `-0.15` total
- Every nudge must include an inline citation to the memory entry id and source
- Ignore entries older than 180 days unless they have been re-observed recently

## Step 2 -- Save Report
Save the full evaluation to `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.
Include Block G in the saved report. Add `**Legitimacy:** {tier}` to the report header.

## Step 3 -- Generate PDF
Run the full `pdf` pipeline (read `modes/pdf.md`).

## Step 4 -- Draft Application Answers (only if score >= 4.5)

If the final score is >= 4.5, generate draft answers for the application form:

1. **Extract form questions**: Use Playwright to navigate to the form and take a snapshot. If questions can't be extracted, use generic questions.
2. **Generate answers** following the tone guidelines below.
3. **Save in the report** as section `## H) Draft Application Answers`.

### Generic questions (use if form questions can't be extracted)

- Why are you interested in this role?
- Why do you want to work at [Company]?
- Tell us about a relevant project or achievement
- What makes you a good fit for this position?
- How did you hear about this role?

### Tone for Form Answers

Read `modes/humanizer.md` before writing any answers.

**Position: "I'm choosing you."** The candidate has options and is choosing this company for concrete reasons.

**Tone rules:**
- **Confident without arrogance**: "I've spent the past year building production AI workflows. Your role is where I want to apply that experience next"
- **Selective without ego**: "I've been intentional about finding a team where I can contribute meaningfully from day one"
- **Specific and concrete**: Always reference something REAL from the JD or the company, and something REAL from the candidate's experience
- **Direct, no fluff**: 2-4 sentences per answer. No "I'm passionate about..." or "I would love the opportunity to..."
- **The hook is the proof, not the claim**: Instead of "I'm great at X", say "I built X that does Y"

**Framework per question:**
- **Why this role?** "Your [specific thing] maps directly to [specific thing I built]."
- **Why this company?** Mention something concrete. "I've been using [product] for [time/purpose]."
- **Relevant experience?** One quantified proof point. "Built [X] that [metric]."
- **Good fit?** "I sit at the intersection of [A] and [B], which is exactly where this role lives."
- **How did you hear?** Honest: "Found through [portal/scan], evaluated against my criteria, and it scored highest."

**Language**: Always in the language of the JD (EN default).

## Step 5 -- Update Tracker
Register in `data/applications.md` with all columns including Report and PDF as checked.

## Step 6 -- Write Memory (max 1 entry per invocation)

After the report is saved, upsert at most one durable memory entry if the signal is strong enough:
- `memory/comp-history.md` for compensation ranges explicitly mentioned and how they affected the score or apply/skip decision
- `memory/location-decisions.md` for repeated geo-policy or remote-policy decisions
- `memory/archetype-performance.md` for strong archetype-fit evidence that should inform future targeting

Rules:
- Use the helper in `dashboard-web/lib/memory.mjs`
- Include `source:` on every write
- Never overwrite `user_edited: true`; write a new entry with `supersedes:` if needed
- Skip the write entirely if there is no durable signal

**If any step fails**, continue with the remaining steps and mark the failed step as pending in the tracker.
