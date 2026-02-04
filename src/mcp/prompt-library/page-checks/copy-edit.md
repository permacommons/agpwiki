Please copy-edit the wiki article at "{{slug}}".

## Purpose

Improve grammar, clarity, and style while preserving meaning. Keep changes minimal and non-substantive. If a meaning-level change is necessary to resolve a copy issue (e.g., an unexplained acronym), propose it and discuss with a human editor before editing.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content.

## Step 3: Identify copy issues
Look for:
- Grammar, punctuation, and spelling errors
- Awkward or unclear phrasing
- Style inconsistencies (per `/meta/style`)
- Sentences whose meaning is unclear as written

## Step 4: Report findings
Write a concise report that a human editor can act on. Summarize the types and severity of issues; you do not need to provide diffs.

### Issues Found

**High (Unclear meaning / likely misunderstanding):**
- ...

**Medium (Clarity or flow issues):**
- ...

**Low (Minor grammar/punctuation/style):**
- ...

### Notes (Optional)
Include any nuance that helps a reviewer understand severity or scope. Keep this short.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which edits to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `copy_edit`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count all issues found by severity, even if summarized in prose.
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
