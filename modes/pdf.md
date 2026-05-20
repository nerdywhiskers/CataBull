# Mode: pdf -- ATS-Optimized PDF Generation

Read `modes/humanizer.md` before writing any text content for the CV.

## Full Pipeline

1. Read `cv.md` as source of truth
2. Ask the user for the JD if not in context (text or URL)
3. Extract 15-20 keywords from the JD
4. Detect JD language (EN default)
5. Detect company location and set paper format:
   - US/Canada: `letter`
   - Rest of world: `a4`
6. Detect role archetype and adapt framing
7. Rewrite Professional Summary injecting JD keywords + exit narrative bridge
8. Select top 3-4 most relevant projects for the offer
9. Reorder experience bullets by relevance to the JD
10. Build competency grid from JD requirements (6-8 keyword phrases)
11. Inject keywords naturally into existing achievements (NEVER invent)
12. Generate complete HTML from template + personalized content
13. Read `name` from `config/profile.yml`, normalize to kebab-case lowercase (e.g. "John Doe" -> "john-doe") -> `{candidate}`
14. Write HTML to `/tmp/cv-{candidate}-{company}.html`
15. Execute: `node generate-pdf.mjs /tmp/cv-{candidate}-{company}.html output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}`
16. Report: PDF path, page count, keyword coverage %

## ATS Rules (clean parsing)

- Single-column layout (no sidebars, no parallel columns)
- Standard headers: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS ignores them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- JD keywords distributed: Summary (top 5), first bullet of each role, Skills section

## PDF Design

- **Fonts**: Space Grotesk (headings, 600-700) + DM Sans (body, 400-500)
- **Fonts self-hosted**: `fonts/`
- **Header**: name in Space Grotesk 24px bold + gradient line `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))` 2px + contact row
- **Section headers**: Space Grotesk 13px, uppercase, letter-spacing 0.05em, color cyan primary
- **Body**: DM Sans 11px, line-height 1.5
- **Company names**: color accent purple `hsl(270,70%,45%)`
- **Margins**: 0.6in
- **Background**: pure white

## Section Order (optimized for "6-second recruiter scan")

1. Header (large name, gradient, contact info, portfolio link)
2. Professional Summary (3-4 lines, keyword-dense)
3. Core Competencies (6-8 keyword phrases in flex-grid)
4. Work Experience (reverse chronological)
5. Projects (top 3-4 most relevant)
6. Education & Certifications
7. Skills (languages + technical)

## Keyword Injection Strategy (ethical, truth-based)

Examples of legitimate rephrasing:
- JD says "creative pipeline design" and CV says "workflow development" -> change to "creative pipeline design and workflow development"
- JD says "generative AI" and CV says "AI tools" -> change to "generative AI tools and production workflows"
- JD says "stakeholder management" and CV says "collaborated with team" -> change to "stakeholder management across creative, product, and engineering"

**NEVER add skills the candidate doesn't have. Only rephrase real experience using the exact vocabulary of the JD.**

## HTML Template

Use the template in `templates/cv-template.html`. Replace the `{{...}}` placeholders with personalized content.

Key placeholders: `{{LANG}}`, `{{PAGE_WIDTH}}`, `{{NAME}}`, `{{EMAIL}}`, `{{PHONE}}`, `{{LOCATION}}`, `{{LINKEDIN_URL}}`, `{{PORTFOLIO_URL}}`, `{{SUMMARY_TEXT}}`, `{{COMPETENCIES}}`, `{{EXPERIENCE}}`, `{{PROJECTS}}`, `{{EDUCATION}}`, `{{SKILLS}}`

Read `config/profile.yml` for all personal info fields. Omit any field that's empty.

## Canva CV Generation (optional)

If `config/profile.yml` has `canva_resume_design_id` set, offer the user a choice:
- **"HTML/PDF (fast, ATS-optimized)"** existing flow above
- **"Canva CV (visual, design-preserving)"** uses Canva MCP to duplicate and edit the design

## Post-generation

Update tracker if the offer is already registered: change PDF from unchecked to checked.
