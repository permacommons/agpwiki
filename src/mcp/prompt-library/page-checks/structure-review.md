Please review the structure of the wiki article at "{{slug}}".

## Purpose

Evaluate organization, sectioning, and flow of the existing content. This is not a completeness check: do not flag missing sections as issues unless the existing structure actively harms clarity.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content. Note the current section outline and any long unbroken blocks of text.

## Step 3: Identify structural issues
Look for:
- Sections that are out of order or make the narrative hard to follow
- Redundant or overlapping sections
- Headings that are too broad or too narrow
- Long walls of text with no subheadings
- Packing controversial content into a single section when it is relevant across multiple sections
- TOC flow that does not match the article’s purpose

## Step 4: Report findings
Summarize the structural issues and suggest changes. Propose new headings if it would improve clarity. For small issues, targeted suggestions are enough; for large issues, propose a revised outline.

### Issues Found

**High (Structure blocks understanding):**
- ...

**Medium (Ordering or grouping could be improved):**
- ...

**Low (Minor flow or heading refinements):**
- ...

### Notes (Optional)
Short guidance or rationale for the proposed structure changes.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which structural edits to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `structure_review`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count all issues found by severity, even if summarized in prose.
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
