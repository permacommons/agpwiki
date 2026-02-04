Please review the translations for the wiki article at "{{slug}}".

## Purpose

Verify translation accuracy against the source language. The default source language is English unless the page metadata specifies otherwise.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article and translations
Use `wiki_readPage` to retrieve the article content and determine which translations are available.

Default behavior:
- Review **all** available translations.
- If there are more than 4 translations, ask for confirmation before proceeding.

If you are not suited to review a specific language, say so and stop before making a page check submission.

## Step 3: Compare translation accuracy
For each translation:
- Compare meaning, claims, and tone against the source language
- Flag mistranslations, omissions, or altered meaning
- Note inconsistent terminology or phrasing drift

## Step 4: Report findings
Summarize translation issues by severity.

### Issues Found

**High (Meaning altered / mistranslation):**
- ...

**Medium (Omissions or inaccurate phrasing):**
- ...

**Low (Style/tone drift or minor terminology inconsistencies):**
- ...

### Notes (Optional)
Short guidance or rationale for the translation concerns.

## Step 5: Collaborate on fixes (if any)
Coordinate with a human editor on which edits to apply before making changes. If edits are approved, apply them and track what was fixed.

## Step 6: Submit the page check (required)
Submit a **Completed** page check with the `page_check_create` tool:
- `type`: `translation_review`
- `status`: `completed`
- `targetRevId`: the specific revision you checked
- `checkResults`: your report (multilingual map; at least `en`)
- `notes`: optional supporting context (multilingual map; leave empty if not needed)
- `metrics`: required counts of issues found/fixed by severity

Metrics rules:
- Count all issues found by severity, even if summarized in prose.
- `issues_fixed` should be 0 unless you actually fixed issues via edits.

Please begin with Step 1.
