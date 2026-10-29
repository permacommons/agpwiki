import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import dal from 'rev-dal';
import { z } from 'zod';
import { initializePostgreSQL } from '../db.js';
import { NotFoundError } from '../lib/errors.js';
import {
  META_PAGES_SLOT,
  missingPromptSlots,
  PROMPT_SPECS,
  type PromptSpec,
  promptPageSlug,
  requiredPromptSlots,
} from '../lib/prompt-registry.js';
import { readWikiPage } from '../services/wiki-page-service.js';

const { mlString } = dal;

/**
 * Common editorial guidelines that agents should read before wiki operations.
 */
const META_PAGES_INSTRUCTION = `Before proceeding, ensure you're familiar with the wiki's editorial guidelines:
- Read \`/meta/values\` to understand the wiki's core values
- Read \`/meta/scope\` to understand what topics are appropriate
- Read \`/meta/style\` to understand the wiki's style guide
- Read \`/meta/citations\` to understand citation standards and expectations

If you haven't read these pages yet, retrieve them now using the wiki_readPage tool.`;

const unavailable = (spec: PromptSpec, problem: string) =>
  new McpError(
    ErrorCode.InternalError,
    `The "${spec.title}" workflow is unavailable: ${problem} An admin can restore the page from its history.`
  );

/** The workflow text from its wiki page, with the slots filled in. */
export const loadPromptText = async (spec: PromptSpec, value: string) => {
  const slug = promptPageSlug(spec.id);
  const dalInstance = await initializePostgreSQL();
  const page = await readWikiPage(dalInstance, slug).catch(error => {
    if (error instanceof NotFoundError) throw unavailable(spec, `the page meta/prompts/${spec.id} is missing.`);
    throw error;
  });
  const template = mlString.resolve(page.originalLanguage ?? 'en', page.body ?? null)?.str ?? '';
  const missing = missingPromptSlots(template, requiredPromptSlots(slug) ?? []);
  if (missing.length) {
    throw unavailable(spec, `the page ${slug} lacks ${missing.map(name => `{{${name}}}`).join(', ')}.`);
  }
  const text = [
    [META_PAGES_SLOT, META_PAGES_INSTRUCTION],
    [spec.slot.name, value],
  ].reduce((current, [name, replacement]) => current.replaceAll(`{{${name}}}`, replacement), template);
  // Lets a strange result be traced to the exact text the agent got.
  return `${text}\n\n(Workflow text from /${slug}, revision ${page.currentRevId}.)`;
};

/**
 * Registers MCP prompts that guide agents through common workflows.
 */
export const registerPrompts = (server: McpServer) => {
  for (const spec of PROMPT_SPECS) {
    server.registerPrompt(
      spec.id,
      {
        title: spec.title,
        description: spec.description,
        argsSchema: {
          [spec.slot.name]: z.string().describe(spec.slot.description),
        },
      },
      async (args: Record<string, string>) => {
        const value = args[spec.slot.name] ?? '';
        return {
          description: spec.describe(value),
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: await loadPromptText(spec, value),
              },
            },
          ],
        };
      }
    );
  }
};
