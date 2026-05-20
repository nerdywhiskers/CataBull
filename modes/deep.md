# Mode: deep -- Deep Company Research

Generates a structured research prompt with 6 axes. Use WebSearch to fill in the answers.

```
## Deep Research: [Company] -- [Role]

Context: Evaluating a candidacy for [role] at [company]. Need actionable intel for the interview.

### 1. AI Strategy
- What products/features use AI/ML?
- What's their AI stack? (models, infra, tools)
- Do they have an engineering blog? What do they publish?
- Any papers or talks about AI?

### 2. Recent Moves (last 6 months)
- Relevant hires in AI/ML/product/creative?
- Acquisitions or partnerships?
- Product launches or pivots?
- Funding rounds or leadership changes?

### 3. Engineering & Creative Culture
- How do they ship? (deploy cadence, CI/CD)
- What languages/frameworks/tools do they use?
- Remote-first or office-first?
- Glassdoor/Blind reviews on culture?

### 4. Likely Challenges
- Scaling problems?
- Reliability, cost, latency challenges?
- Migrating anything? (infra, models, platforms)
- Pain points mentioned in reviews?

### 5. Competitors & Differentiation
- Who are their main competitors?
- What's their moat/differentiator?
- How do they position vs. competition?

### 6. Candidate Angle
Given the candidate's profile (read from cv.md and profile.yml):
- What unique value do they bring to this team?
- Which projects are most relevant?
- What story should they tell in the interview?
```

Personalize each section with the specific context from the evaluated offer.
