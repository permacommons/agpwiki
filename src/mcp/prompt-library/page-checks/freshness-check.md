Please run a freshness check on the wiki article at "{{slug}}".

## Purpose

Identify content that appears out of date (e.g., roles/titles, statistics, dates, and other time-sensitive claims). This is not a link integrity check.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content. Identify time-sensitive assertions that could become inaccurate if not updated.

## Step 3: Verify recency where possible
Use citations and available sources to verify whether time-sensitive claims are still current. It is helpful to follow citations that are likely to change (e.g., official sites), but do not audit whether old citations are still reachable.

## Step 4: Report findings
Summarize outdated or likely outdated content. If you cannot verify recency, list it as a potential concern (excluded from metrics).

### Issues Found

**High (Clearly outdated or incorrect current-role claims):**
- ...

**Medium (Likely outdated statistics or time-sensitive claims):**
- ...

**Low (Minor time wording or small recency issues):**
- ...

**Potential Concerns (Verify Independently, Not Counted in Metrics):**
- ...

### Notes (Optional)
Short guidance or rationale for the recency concerns.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which updates to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `freshness_check`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count only confirmed issues in `issues_found` (exclude “Potential Concerns”).
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
