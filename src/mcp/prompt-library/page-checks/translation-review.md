Please review the translations for the wiki article at "{{slug}}".

## Purpose

Verify translation accuracy against the canonical version of the page: the language in its `originalLanguage` field. Translations are made from the canonical version, never from another translation.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article and translations
Use `wiki_readPage` with `lang: "*"` to retrieve the article in all its languages and determine which translations are available. (Without `lang`, it returns only one language.)

`translatedFrom` shows, for each translation recorded as such, the canonical revision it was made from and `editsBehind`, the number of edits to the canonical text since. A translation that is behind may be missing those changes: compare it with the canonical revision it was made from, and use `wiki_diffRevisions` from that revision to see what it is missing.

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
Coordinate with a human editor on which edits to apply before making changes. If edits are approved, apply them and track what was fixed. When you bring a translation up to date with the canonical version, pass `translatedFrom` (the canonical language and the revision you translated from) with the edit. If you correct something in a translation that is also wrong in the canonical version, fix the canonical version in the same session.

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
