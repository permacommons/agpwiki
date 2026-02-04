Please run an accessibility check on the wiki article at "{{slug}}".

## Purpose

Improve readability and accessibility expectations for human readers. Use empirically established readability heuristics.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content.

## Step 3: Identify accessibility and readability issues
Look for:
- Sentence length issues
- Paragraph length issues
- Heading density and hierarchy problems
- List density issues
- Link text clarity (avoid vague labels like “click here”)
- Image alt text expectations (when images are present)
- Tables that are hard to read or scan

## Step 4: Report findings
Summarize the readability and accessibility issues.

### Issues Found

**High (Hard to parse, missing alt text, or otherwise inaccessible):**
- ...

**Medium (Readability issues that slow comprehension):**
- ...

**Low (Minor clarity or polish issues):**
- ...

### Notes (Optional)
Short guidance or rationale for the accessibility concerns.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which edits to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `accessibility_check`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count all issues found by severity, even if summarized in prose.
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
