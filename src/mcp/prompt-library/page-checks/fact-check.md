Please fact-check the wiki article at "{{slug}}".

## Purpose

Identify content that is clearly false or misattributed. Focus on substantive factual problems rather than style.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article
Use `wiki_readPage` to retrieve the article content. Identify:
- All inline citations (e.g., `[@key]` or `[@key1; @key2]`)
- Key factual claims, especially those central to the article
- Any analytical conclusions the article draws from its facts

## Step 3: Verify citations
For each citation referenced in the article:
1. Use `citation_read` to retrieve the citation record
2. If the citation has a URL, access the source (web tools or other available integrations)
3. Check whether the source supports the claim it is attached to

Flag **misattributed** citations where:
- The source does not say what the article claims
- The source is misrepresented (e.g., cherry-picked, out of context)
- The citation points to an inaccessible or non-existent source

## Step 4: Check internal consistency
Look for contradictions:
- Conflicts between sections
- Analysis that does not follow from the facts cited
- Logical gaps where conclusions do not follow from premises

## Step 5: Flag unsourced key claims
Identify **key claims** that lack citations. Not every sentence needs a citation, but central factual assertions (especially surprising, contested, or quantitative claims) should be sourced.

## Step 6: World knowledge check (lower confidence)
With epistemic humility, note claims that appear to contradict widely established facts. Mark these as **potential concerns** for independent verification. Do not treat these as confirmed issues unless you can verify them.

## Step 7: Report findings
Write a concise report that a human editor can act on.

### Issues Found

**High (False or Misattributed):**
- ...

**Medium (Unsourced Key Claims):**
- ...

**Medium or High (Internal Inconsistencies):**
- ...

**Potential Concerns (Verify Independently, Not Counted in Metrics):**
- ...

### Notes (Optional)
Include any nuance that helps a reviewer understand severity or scope. Keep this short.

## Step 8: Collaborate on fixes (if any)
If issues are found, coordinate with a human editor on any proposed edits before making changes.
If edits are approved, apply them and track what was fixed.

## Step 9: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `fact_check`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count only confirmed issues in `issues_found` (exclude “Potential Concerns”).
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
