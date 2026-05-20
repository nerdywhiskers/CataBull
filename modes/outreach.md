# Outreach Mode — Contact Discovery & LinkedIn Intro Drafting

## Your Task

Find relevant hiring managers, recruiters, or team leads for the given role at the given company, and draft personalized LinkedIn intro messages.

## Step 1: Research Contacts

Find 2-3 relevant contacts. Run multiple searches — cast a wide net then pick the best.

### Search strategy (use WebSearch for all of these):

**Direct hiring manager** (most valuable):
- `site:linkedin.com/in "[Company]" "Art Director"` or `"Creative Director"` or `"Head of Design"`
- `site:linkedin.com/in "[Company]" "[one level above the role title]"`

**Recruiter / Talent Acquisition:**
- `site:linkedin.com/in "[Company]" "recruiter" OR "talent acquisition" "creative" OR "design"`
- `site:linkedin.com/in "[Company]" "recruiting" "art" OR "creative" OR "design"`

**Team leads / peers:**
- `site:linkedin.com/in "[Company]" "creative" "lead" OR "senior" OR "principal"`

**Company research (for context in messages):**
- `"[Company]" "creative team" OR "design team" OR "art team" site:linkedin.com`
- Check the company's careers page or About page for team structure

**Job posting clues:**
- Read the JD at the provided URL first — it often mentions team name, department, or reporting structure
- Use any specific team/product names in your LinkedIn searches

### For each contact found, extract:
- Full name
- Title
- LinkedIn URL (full profile URL)
- Why they're relevant (hiring manager, recruiter, team lead, etc.)
- Any shared connections or interests (schools, past companies, mutual interests)

## Step 2: Draft LinkedIn Intro Messages

Before drafting, query `memory/outreach-effectiveness.md` for active entries that match the company size, sector, or motion. Use that memory to prefer the tone/angle with the best observed reply rate. If memory is sparse, say so implicitly by drafting normally rather than inventing a pattern.

For each contact, draft a short, personalized LinkedIn connection request message (under 300 characters for the connection note, plus a longer follow-up message).

**Connection request note** (max 300 chars):
- Reference the specific role
- Mention one relevant thing about YOUR background (from cv.md and profile.yml)
- Be genuine, not salesy

**Follow-up message** (if they accept):
- Brief intro connecting your experience to their team's work
- Reference a specific project or initiative at their company
- Ask a thoughtful question (not "are you hiring?")
- Include your portfolio URL if relevant

## Step 3: Save Results

Save the outreach report to `data/outreach/{company-slug}-{role-slug}.md` with this format:

```markdown
# Outreach: {Company} — {Role}

**Role URL:** {url}
**Date:** {today}

## Contacts

### 1. {Name} — {Title}
**LinkedIn:** {url}
**Relevance:** {why this person}

**Connection note:**
> {300 char max message}

**Follow-up message:**
> {longer message}

---

### 2. {Name} — {Title}
...
```

## Step 4: Write Memory (max 1 entry)

If you observe a durable outreach signal, upsert one entry into `memory/outreach-effectiveness.md`.

Good candidates:
- a tone that clearly matches the company size or sector
- a contact angle that consistently performs better for a segment
- a repeated pattern about recruiter vs hiring-manager response quality

Always include `source:` and keep the write to one entry per mode invocation.

## Guidelines

- **Read `modes/humanizer.md` first** — all messages MUST follow its writing style rules
- Read `cv.md` and `config/profile.yml` for the user's background and narrative
- Read `modes/_profile.md` for the user's cross-cutting advantage and adaptive framing
- Read `memory/outreach-effectiveness.md` before choosing tone when entries exist
- Tailor messages to the specific role type (use the archetype framing)
- NEVER be generic — every message should reference something specific about the company or the contact's work
- NEVER lie about qualifications — only reference real experience from cv.md
