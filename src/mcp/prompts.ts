import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const PROMPT_LIBRARY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'prompt-library'
);

type PromptTemplateSpec = {
  id: string;
  title: string;
  description: string;
  templatePath: string;
};

const PAGE_CHECK_PROMPTS: PromptTemplateSpec[] = [
  {
    id: 'fact-check',
    title: 'Fact-Check Article',
    description: 'Verify factual accuracy, citation integrity, and internal consistency',
    templatePath: 'page-checks/fact-check.md',
  },
  {
    id: 'copy-edit',
    title: 'Copy Edit Article',
    description: 'Improve grammar, clarity, and style while preserving meaning',
    templatePath: 'page-checks/copy-edit.md',
  },
  {
    id: 'structure-review',
    title: 'Structure Review',
    description: 'Review organization, sectioning, and flow',
    templatePath: 'page-checks/structure-review.md',
  },
  {
    id: 'freshness-check',
    title: 'Freshness Check',
    description: 'Identify outdated claims, stats, and roles',
    templatePath: 'page-checks/freshness-check.md',
  },
  {
    id: 'link-integrity',
    title: 'Link Integrity Check',
    description: 'Verify links resolve and point to intended destinations',
    templatePath: 'page-checks/link-integrity.md',
  },
  {
    id: 'plagiarism-scan',
    title: 'Plagiarism Scan',
    description: 'Check for uncredited copying and attribution risks',
    templatePath: 'page-checks/plagiarism-scan.md',
  },
  {
    id: 'accessibility-check',
    title: 'Accessibility Check',
    description: 'Review readability and accessibility expectations',
    templatePath: 'page-checks/accessibility-check.md',
  },
  {
    id: 'translation-review',
    title: 'Translation Review',
    description: 'Verify correctness against the source language',
    templatePath: 'page-checks/translation-review.md',
  },
  {
    id: 'formatting-check',
    title: 'Formatting Check',
    description: 'Check Markdown correctness and rendering expectations',
    templatePath: 'page-checks/formatting-check.md',
  },
];

const promptTemplateCache = new Map<string, string>();

function resolvePromptPath(libraryPath: string): string {
  const resolved = path.resolve(PROMPT_LIBRARY_ROOT, libraryPath);
  if (!resolved.startsWith(PROMPT_LIBRARY_ROOT + path.sep)) {
    throw new Error(`Invalid prompt template path: ${libraryPath}`);
  }
  return resolved;
}

function loadPromptTemplate(libraryPath: string): string {
  const cached = promptTemplateCache.get(libraryPath);
  if (cached) {
    return cached;
  }
  const resolvedPath = resolvePromptPath(libraryPath);
  const contents = readFileSync(resolvedPath, 'utf8');
  promptTemplateCache.set(libraryPath, contents);
  return contents;
}

function renderPromptTemplate(template: string, slug: string): string {
  return template
    .replaceAll('{{metaPages}}', META_PAGES_INSTRUCTION)
    .replaceAll('{{slug}}', slug);
}

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

  PAGE_CHECK_PROMPTS.forEach(spec => {
    server.registerPrompt(
      spec.id,
      {
        title: spec.title,
        description: spec.description,
        argsSchema: {
          slug: z.string().describe('The slug of the article to review'),
        },
      },
      async ({ slug }) => {
        const template = loadPromptTemplate(spec.templatePath);
        return {
          description: `${spec.title}: ${slug}`,
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: renderPromptTemplate(template, slug),
              },
            },
          ],
        };
      }
    );
  });
};
