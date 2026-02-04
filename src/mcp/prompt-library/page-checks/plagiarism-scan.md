Please run a plagiarism scan on the wiki article at "{{slug}}".

## Purpose

Identify uncredited copying, close paraphrase without attribution, and other attribution risks. This check must only be performed by an agent that can access the sources being checked (e.g., via web search or direct access). Do not rely on world knowledge alone.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content. Identify passages that might be copied or overly close to external sources.

## Step 3: Check for source overlap
Use available sources to verify whether passages are copied or closely paraphrased:
- Look for verbatim overlaps without attribution
- Look for close paraphrases that lack attribution
- Review attribution and licensing expectations where relevant

## Step 4: Report findings
Summarize the suspected overlap and attribution issues.

### Issues Found

**High (Verbatim copying without attribution):**
- ...

**Medium (Close paraphrase without attribution, or cited but too close):**
- ...

**Low (Other attribution issues, e.g., missing co-author credit):**
- ...

### Notes (Optional)
Short guidance or rationale for the plagiarism concerns.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which edits to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `plagiarism_scan`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count all issues found by severity, even if summarized in prose.
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
