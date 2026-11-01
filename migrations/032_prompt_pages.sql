-- The guided prompts agents offer move from src/mcp/prompt-library to wiki
-- pages under meta/prompts/, protected so only admins can edit them. Pages
-- that already exist are left alone, so this is safe to run anywhere.

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/create-article', '{"en": "Create Article"}'::jsonb, jsonb_build_object('en', $prompt$I want to create a wiki article about "{{topic}}".

Please follow these instructions:

## Step 1: Understand the wiki's values and scope
{{metaPages}}

## Step 2: Research and outline
- Research the topic and identify potential citations (academic papers, authoritative sources, etc.)
- Sketch out an article outline with the key sections you plan to cover
- For each major claim, note which citation would support it

**IMPORTANT**: Do NOT create citation records yet. Present your outline and proposed citations to me first. It's my job to verify that:
1. The citations are real and accessible
2. They actually support the claims you want to make with them

**On source accessibility**: Only propose citations you can actually access — you must have read the relevant section yourself, either by fetching it from the web or via another available tool. Do not cite sources based on titles or abstracts alone, or sources that are paywalled or otherwise inaccessible to you. If you cannot verify that a source says what you think it says, do not include it.

## Step 3: Review checkpoint
Present your outline and proposed citations for my review. Wait for my approval before proceeding.

## Step 4: Create citations
Once I've signed off on your proposed citations:
- Use the citation_create tool to create each citation record
- Use CSL JSON format for the citation data
- Use meaningful citation keys (e.g., "smith2020quantum" not "ref1")

## Step 5: Create the article
- Use the wiki_createPage tool to create the article
- Use `[@citation-key]` syntax for inline citations, optionally with `:claim-id`
- The bibliography will be auto-generated from your citations
- The create response omits the full body; use wiki_readPage if you need to inspect the saved content
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/create-article' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/fact-check', '{"en": "Fact-Check Article"}'::jsonb, jsonb_build_object('en', $prompt$Please fact-check the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/fact-check' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/copy-edit', '{"en": "Copy Edit Article"}'::jsonb, jsonb_build_object('en', $prompt$Please copy-edit the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/copy-edit' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/structure-review', '{"en": "Structure Review"}'::jsonb, jsonb_build_object('en', $prompt$Please review the structure of the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/structure-review' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/freshness-check', '{"en": "Freshness Check"}'::jsonb, jsonb_build_object('en', $prompt$Please run a freshness check on the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/freshness-check' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/link-integrity', '{"en": "Link Integrity Check"}'::jsonb, jsonb_build_object('en', $prompt$Please run a link integrity check on the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/link-integrity' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/plagiarism-scan', '{"en": "Plagiarism Scan"}'::jsonb, jsonb_build_object('en', $prompt$Please run a plagiarism scan on the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/plagiarism-scan' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/accessibility-check', '{"en": "Accessibility Check"}'::jsonb, jsonb_build_object('en', $prompt$Please run an accessibility check on the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/accessibility-check' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/translation-review', '{"en": "Translation Review"}'::jsonb, jsonb_build_object('en', $prompt$Please review the translations for the wiki article at "{{slug}}".

## Purpose

Verify translation accuracy against the source language. The default source language is English unless the page metadata specifies otherwise.

## Step 1: Understand editorial standards
{{metaPages}}

## Step 2: Retrieve the article and translations
Use `wiki_readPage` with `lang: "*"` to retrieve the article in all its languages and determine which translations are available. (Without `lang`, it returns only one language.)

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/translation-review' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;

WITH created AS (
  INSERT INTO pages (slug, title, body, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _rev_summary)
  SELECT 'meta/prompts/formatting-check', '{"en": "Formatting Check"}'::jsonb, jsonb_build_object('en', $prompt$Please run a formatting check on the wiki article at "{{slug}}".

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
$prompt$::text), 'en',
         gen_random_uuid(), NULL, NOW(), ARRAY['create', 'import'],
         '{"en": "Imported from the agpwiki code (src/mcp/prompt-library)."}'::jsonb
  WHERE NOT EXISTS (
    SELECT 1 FROM pages WHERE slug = 'meta/prompts/formatting-check' AND _old_rev_of IS NULL AND _rev_deleted = false
  )
  RETURNING id
)
INSERT INTO page_protections (page_id, reason, level)
SELECT id, 'Instructions that agents follow; only admins can edit them.', 'admins' FROM created;
