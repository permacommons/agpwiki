import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Common editorial guidelines that agents should read before wiki operations.
 */
const META_PAGES_INSTRUCTION = `Before proceeding, ensure you're familiar with the wiki's editorial guidelines:
- Read \`/meta/values\` to understand the wiki's core values
- Read \`/meta/scope\` to understand what topics are appropriate
- Read \`/meta/style\` to understand the wiki's style guide
- Read \`/meta/citations\` to understand citation standards and expectations

If you haven't read these pages yet, retrieve them now using the wiki_readPage tool.`;

/**
 * Registers MCP prompts that guide agents through common workflows.
 */
export const registerPrompts = (server: McpServer) => {
  server.registerPrompt(
    'create-article',
    {
      title: 'Create Article',
      description: 'Guided workflow for creating a well-sourced wiki article',
      argsSchema: {
        topic: z.string().describe('The topic for the new article'),
      },
    },
    async ({ topic }) => {
      return {
        description: `Workflow for creating an article about: ${topic}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `I want to create a wiki article about "${topic}".

Please follow this workflow:

## Step 1: Understand the wiki's values and scope
${META_PAGES_INSTRUCTION}

## Step 2: Research and outline
- Research the topic and identify potential citations (academic papers, authoritative sources, etc.)
- Sketch out an article outline with the key sections you plan to cover
- For each major claim, note which citation would support it

**IMPORTANT**: Do NOT create citation records yet. Present your outline and proposed citations to me first. It's my job to verify that:
1. The citations are real and accessible
2. They actually support the claims you want to make with them

## Step 3: Review checkpoint
Present your outline and proposed citations for my review. Wait for my approval before proceeding.

## Step 4: Create citations
Once I've signed off on your proposed citations:
- Use the citation_create tool to create each citation record
- Use CSL JSON format for the citation data
- Use meaningful citation keys (e.g., "smith2020quantum" not "ref1")

## Step 5: Final review checkpoint
After creating the citations, check in with me to confirm we're ready to create the article.

## Step 6: Create the article
Once approved:
- Use the wiki_createPage tool to create the article
- Use \`[@citation-key]\` syntax for inline citations
- The bibliography will be auto-generated from your citations

Please begin with Step 1.`,
            },
          },
        ],
      };
    }
  );

  server.registerPrompt(
    'fact-check',
    {
      title: 'Fact-Check Article',
      description:
        'Verify an article for factual accuracy, citation integrity, and internal consistency',
      argsSchema: {
        slug: z.string().describe('The slug of the article to fact-check'),
      },
    },
    async ({ slug }) => {
      return {
        description: `Fact-checking article: ${slug}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Please fact-check the wiki article at "${slug}".

## Purpose

The goal is to identify content that is **clearly FALSE or MISATTRIBUTED**. This is not about nit-picking or stylistic preferences—focus on substantive factual problems.

## Step 1: Understand editorial standards
${META_PAGES_INSTRUCTION}

## Step 2: Retrieve the article
Use wiki_readPage to retrieve the article content. Identify:
- All inline citations (e.g., \`[@key]\` or \`[@key1; @key2]\`)
- Key factual claims, especially those that are central to the article's argument
- Any analytical conclusions the article draws from its facts

## Step 3: Verify citations
For each citation referenced in the article:
1. Use citation_read to retrieve the citation record
2. If the citation has a URL, use web tools to access the source content—or check if the source is available to you through other tools (e.g., local filesystem resources, databases, or other configured integrations)
3. Check whether the source actually supports the claim it's attached to

Flag any **MISATTRIBUTED** citations where:
- The source doesn't say what the article claims it says
- The source is misrepresented (e.g., cherry-picked, taken out of context)
- The citation points to an inaccessible or non-existent source

## Step 4: Check internal consistency
Review the article for internal contradictions:
- Does the article contradict itself between sections?
- If the article presents analysis, is that analysis consistent with the facts it cites?
- Are there logical gaps where conclusions don't follow from premises?

## Step 5: Flag unsourced claims
Identify any **key claims** that lack citations. Not every sentence needs a citation, but central factual assertions—especially surprising, contested, or quantitative claims—should be sourced.

## Step 6: World knowledge check (lower confidence)
With appropriate epistemic humility, note any claims that appear to contradict widely-established facts. Mark these as "may benefit from verification" rather than definitive errors.

**Important caveats:**
- Your training data has a cutoff and may be incomplete
- LLMs are prone to hallucination—this applies both to content you're fact-checking (which may have been written or assisted by an LLM) and to your own fact-checking (you may confidently "recall" facts that are incorrect)
- When in doubt, flag for human verification rather than asserting error

## Step 7: Report findings

Structure your report as:

### Issues Found

**Critical (FALSE or MISATTRIBUTED):**
- List any statements that are demonstrably false or where citations don't support the claims

**Unsourced Key Claims:**
- List important claims that should have citations but don't

**Internal Inconsistencies:**
- List any logical contradictions within the article

**Potential Concerns (verify independently):**
- List anything that contradicts your world knowledge, with the caveat that independent verification is recommended

### Minor Suggestions (if any)
At the end only, you may briefly note any nuances that could be explained better—but keep this section minimal. The focus is on factual accuracy, not style.

Please begin with Step 1.`,
            },
          },
        ],
      };
    }
  );
};
