import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token';
import citationsPlugin, { type Citation } from '../markdown/citations.js';
import { mediaPlugin, type ParsedMediaRef } from '../markdown/media.js';
import type { ValidationCollector } from './errors.js';

export type MarkdownAnalysis = {
  tokens: Token[];
  citations: Citation[];
  mediaRefs: ParsedMediaRef[];
};

export type ContentValidationContext = {
  fieldLabel: string;
  errors: ValidationCollector;
  analysis: MarkdownAnalysis;
};

export type ContentValidator = (context: ContentValidationContext) => Promise<void> | void;

const parser = new MarkdownIt({ html: false, linkify: true })
  .use(citationsPlugin)
  .use(mediaPlugin());

const collectCitationsFromTokens = (tokens: Token[], result: Citation[]) => {
  for (const token of tokens) {
    if (token.type === 'cite_open') {
      const citeRefs = (token as Token & { citeRefs?: Citation[] }).citeRefs;
      if (citeRefs?.length) {
        result.push(...citeRefs);
      }
    }
    if (token.children?.length) {
      collectCitationsFromTokens(token.children, result);
    }
  }
};

const collectMediaRefsFromTokens = (tokens: Token[], result: ParsedMediaRef[]) => {
  for (const token of tokens) {
    if (token.type === 'media') {
      const ref = token.meta as ParsedMediaRef | undefined;
      if (ref?.slug) {
        result.push(ref);
      }
    }
    if (token.children?.length) {
      collectMediaRefsFromTokens(token.children, result);
    }
  }
};

export const analyzeMarkdown = (text: string): MarkdownAnalysis => {
  if (!text) {
    return { tokens: [], citations: [], mediaRefs: [] };
  }
  const tokens = parser.parse(text, {});
  const citations: Citation[] = [];
  const mediaRefs: ParsedMediaRef[] = [];
  collectCitationsFromTokens(tokens, citations);
  collectMediaRefsFromTokens(tokens, mediaRefs);
  return { tokens, citations, mediaRefs };
};

export const validateMarkdownContent = async (
  text: string,
  fieldLabel: string,
  errors: ValidationCollector,
  validators: ContentValidator[]
) => {
  const analysis = analyzeMarkdown(text);
  for (const validator of validators) {
    await validator({ fieldLabel, errors, analysis });
  }
};

export const validateLocalizedMarkdownContent = async (
  value: Record<string, string | null> | null | undefined,
  fieldLabel: string,
  errors: ValidationCollector,
  validators: ContentValidator[]
) => {
  if (!value) return;
  for (const [lang, text] of Object.entries(value)) {
    if (!text) continue;
    await validateMarkdownContent(text, `${fieldLabel}.${lang}`, errors, validators);
  }
};
