Please run a link integrity check on the wiki article at "{{slug}}".

## Purpose

Verify that links (internal and external) resolve and point to the intended destinations. This check is about link health, not content freshness.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content. Identify all links (internal and external).

## Step 3: Verify links
Check that each link:
- Resolves (no 404s or soft 404s)
- Points to the intended destination for the surrounding text
- Does not contain excessive redirect chains

## Step 4: Report findings
Summarize broken, misdirected, or problematic links.

### Issues Found

**High (404s, soft 404s, or wrong destination):**
- ...

**Medium (Timeouts or likely transient failures):**
- ...

**Low (Valid redirects or avoidable redirect chains):**
- ...

### Notes (Optional)
Short guidance or rationale for the link issues.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which link updates to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `link_integrity`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count all issues found by severity, even if summarized in prose.
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
