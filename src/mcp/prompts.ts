import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
Before writing, ensure you're familiar with the wiki's editorial guidelines:
- Read \`/meta/values\` to understand the wiki's core values
- Read \`/meta/scope\` to understand what topics are appropriate

If you haven't read these pages yet, retrieve them now using the wiki_readPage tool.

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
};
