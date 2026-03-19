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

function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  return Object.entries({ metaPages: META_PAGES_INSTRUCTION, ...vars }).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template
  );
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
      const template = loadPromptTemplate('create-article.md');
      return {
        description: `Workflow for creating an article about: ${topic}`,
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: renderPromptTemplate(template, { topic }),
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
                text: renderPromptTemplate(template, { slug }),
              },
            },
          ],
        };
      }
    );
  });
};
