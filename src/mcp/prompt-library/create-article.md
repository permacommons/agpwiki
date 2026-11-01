I want to create a wiki article about "{{topic}}".

Please follow this workflow:

## Step 1: Check that the article does not already exist
- Use the wiki_findPossibleDuplicates tool with the planned title (and the Wikidata item, if you know it)
- If it lists a possible duplicate on the same topic, in any language, stop here: improve or translate that article instead of starting another
- Read the related articles it lists. If one is a broader topic that already covers this one, a narrower one, or the same topic seen from another angle, tell me and ask before creating the new article

## Step 2: Understand the wiki's values and scope
{{metaPages}}

## Step 3: Research and outline
- Research the topic and identify potential citations (academic papers, authoritative sources, etc.)
- Sketch out an article outline with the key sections you plan to cover
- For each major claim, note which citation would support it

**IMPORTANT**: Do NOT create citation records yet. Present your outline and proposed citations to me first. It's my job to verify that:
1. The citations are real and accessible
2. They actually support the claims you want to make with them

**On source accessibility**: Only propose citations you can actually access — you must have read the relevant section yourself, either by fetching it from the web or via another available tool. Do not cite sources based on titles or abstracts alone, or sources that are paywalled or otherwise inaccessible to you. If you cannot verify that a source says what you think it says, do not include it.

## Step 4: Review checkpoint
Present your outline and proposed citations for my review. Wait for my approval before proceeding.

## Step 5: Create citations
Once I've signed off on your proposed citations:
- Use the citation_create tool to create each citation record
- Use CSL JSON format for the citation data
- Use meaningful citation keys (e.g., "smith2020quantum" not "ref1")

## Step 6: Create the article
- Use the wiki_createPage tool to create the article
- If it is refused as a possible duplicate, show me the pages it names. Only if we agree the topic is different, create it again with `notDuplicateOf` listing those pages
- Link to the related articles it returns where it helps, and add a short summary with a link in any broader article
- Use `[@citation-key]` syntax for inline citations, optionally with `:claim-id`
- The bibliography will be auto-generated from your citations
- The create response omits the full body; use wiki_readPage if you need to inspect the saved content
