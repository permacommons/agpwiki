Please run a formatting check on the wiki article at "{{slug}}".

## Purpose

Ensure Markdown is correct and renders as intended. The renderer is configured with `html: false` (no raw HTML) and `linkify: true` (plain URLs become links). MediaWiki syntax is **not supported** and should be flagged.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content.

## Step 3: Identify formatting issues
Look for:
- Malformed headings, lists, tables, or code fences
- Missing blank lines that break list or heading rendering
- Broken inline markup (e.g., mismatched emphasis markers)
- Malformed citation syntax (e.g., incorrect `[@key]` or `[@key1; @key2]` formatting)
- MediaWiki syntax (e.g., `[[link]]`, `== Heading ==`, templates)
- Raw HTML tags (not supported)

## Step 4: Report findings
Summarize formatting issues by severity.

### Issues Found

**High (Breaks rendering or hides content):**
- ...

**Medium (Renders incorrectly but still readable):**
- ...

**Low (Cosmetic or consistency issues):**
- ...

### Notes (Optional)
Short guidance or rationale for the formatting concerns.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which edits to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `formatting_check`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count all issues found by severity, even if summarized in prose.
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
