# Mode: apply -- Live Application Assistant

Interactive mode for when the candidate is filling out a job application form in Chrome. Reads what's on screen, loads prior evaluation context, and generates personalized answers for each form question.

Read `modes/humanizer.md` before writing any user-facing text.

## Requirements

- **Best with Playwright visible**: The candidate sees the browser and Claude can interact with the page.
- **Without Playwright**: The candidate shares a screenshot or pastes the questions manually.

## Workflow

```
1. DETECT     Read active Chrome tab (screenshot/URL/title)
2. IDENTIFY   Extract company + role from the page
3. SEARCH     Match against existing reports in reports/
4. LOAD       Read full report + Section H (if exists)
5. COMPARE    Does the role on screen match the evaluated one? If changed, warn
6. ANALYZE    Identify ALL visible form questions
7. GENERATE   For each question, generate a personalized answer
8. PRESENT    Show formatted answers for copy-paste
```

## Step 1 -- Detect the Offer

**With Playwright:** Take snapshot of the active page. Read title, URL, and visible content.

**Without Playwright:** Ask the candidate to:
- Share a screenshot of the form (Read tool reads images)
- Or paste the form questions as text
- Or provide company + role so we can look it up

## Step 2 -- Identify and Load Context

1. Extract company name and role title from the page
2. Search `reports/` by company name (Grep case-insensitive)
3. If match found, load the full report
4. If Section H exists, load prior draft answers as a starting point
5. If NO match, warn and offer to run auto-pipeline first

## Step 3 -- Detect Role Changes

If the role on screen differs from the evaluated one:
- **Warn the candidate**: "The role has changed from [X] to [Y]. Want me to re-evaluate or adapt the answers to the new title?"
- **If adapt**: Adjust answers to the new role without re-evaluating
- **If re-evaluate**: Run full A-F evaluation, update report, regenerate Section H
- **Update tracker**: Change role title in applications.md if needed

## Step 4 -- Analyze Form Questions

Identify ALL visible questions:
- Free-text fields (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Salary fields (range, expectation)
- Upload fields (resume, cover letter PDF)

Classify each question:
- **Already answered in Section H**: Adapt the existing answer
- **New question**: Generate answer from the report + cv.md

## Step 5 -- Generate Answers

For each question, generate the answer using:

1. **Report context**: Proof points from Block B, STAR stories from Block F
2. **Prior Section H**: If a draft answer exists, use it as a base and refine
3. **"I'm choosing you" tone**: Same framework as auto-pipeline
4. **Specificity**: Reference something concrete from the visible JD
5. **Humanizer rules**: Follow modes/humanizer.md for writing style

**Output format:**

```
## Answers for [Company] -- [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact question from the form]
> [Answer ready for copy-paste]

### 2. [Next question]
> [Answer]

...

---

Notes:
- [Any observations about the role, changes, etc.]
- [Personalization suggestions the candidate should review]
```

## Step 6 -- Post-apply (optional)

If the candidate confirms they submitted the application:
1. Update status in `applications.md` from "Tailored" to "Applied"
2. Update Section H of the report with final answers
3. Suggest next step: `/catabull outreach` for LinkedIn outreach

## Step 7 -- Write Memory (max 1 entry)

If the application surfaced a reusable user preference in how they answer forms, upsert one entry into `memory/user-preferences.md`.

Examples:
- preferred opening angle for "Why this company?"
- tone constraints the user consistently chooses
- recurring phrasing to avoid

Only persist patterns that look reusable across companies. Include `source:` and never overwrite a `user_edited: true` record.

## Scroll Handling

If the form has more questions than visible:
- Ask the candidate to scroll and share another screenshot
- Or paste the remaining questions
- Process in iterations until the full form is covered
