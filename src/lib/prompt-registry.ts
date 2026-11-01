// The guided prompts agents offer. Their text lives on the wiki, at
// meta/prompts/<id>; the list of prompts and the placeholders each takes stay here.

export const PROMPT_PAGE_PREFIX = 'meta/prompts/';

// Filled in by the server; it tells agents to read the editorial policies.
export const META_PAGES_PLACEHOLDER = 'metaPages';

export interface PromptSpec {
  id: string;
  title: string;
  description: string;
  // The argument the agent passes, filled into the text as {{placeholder}}.
  placeholder: { name: 'topic' | 'slug'; description: string };
  describe: (value: string) => string;
}

const pageCheck = (id: string, title: string, description: string): PromptSpec => ({
  id,
  title,
  description,
  placeholder: { name: 'slug', description: 'The slug of the article to review' },
  describe: slug => `${title}: ${slug}`,
});

export const PROMPT_SPECS: PromptSpec[] = [
  {
    id: 'create-article',
    title: 'Create Article',
    description: 'Guided prompt for creating a well-sourced wiki article',
    placeholder: { name: 'topic', description: 'The topic for the new article' },
    describe: topic => `Prompt for creating an article about: ${topic}`,
  },
  pageCheck('fact-check', 'Fact-Check Article', 'Verify factual accuracy, citation integrity, and internal consistency'),
  pageCheck('copy-edit', 'Copy Edit Article', 'Improve grammar, clarity, and style while preserving meaning'),
  pageCheck('structure-review', 'Structure Review', 'Review organization, sectioning, and flow'),
  pageCheck('freshness-check', 'Freshness Check', 'Identify outdated claims, stats, and roles'),
  pageCheck('link-integrity', 'Link Integrity Check', 'Verify links resolve and point to intended destinations'),
  pageCheck('plagiarism-scan', 'Plagiarism Scan', 'Check for uncredited copying and attribution risks'),
  pageCheck('accessibility-check', 'Accessibility Check', 'Review readability and accessibility expectations'),
  pageCheck('translation-review', 'Translation Review', 'Verify correctness against the source language'),
  pageCheck('formatting-check', 'Formatting Check', 'Check Markdown correctness and rendering expectations'),
];

export const promptPageSlug = (id: string) => `${PROMPT_PAGE_PREFIX}${id}`;

export const isPromptPageSlug = (slug: string) => slug.startsWith(PROMPT_PAGE_PREFIX);

/** The placeholders a prompt page must keep, or null if the page is not a registered prompt. */
export const requiredPromptPlaceholders = (slug: string): string[] | null => {
  const spec = PROMPT_SPECS.find(item => promptPageSlug(item.id) === slug);
  return spec ? [spec.placeholder.name, META_PAGES_PLACEHOLDER] : null;
};

/** Placeholders missing from a prompt text, e.g. ['slug']. */
export const missingPromptPlaceholders = (text: string, required: string[]) =>
  required.filter(name => !text.includes(`{{${name}}}`));
