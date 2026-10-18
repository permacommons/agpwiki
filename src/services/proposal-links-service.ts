import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { NotFoundError, ValidationCollector } from '../lib/errors.js';
import { sanitizeLocalizedMapInput } from '../lib/localized.js';
import {
  isProposalSlug,
  MAX_PULL_REQUESTS,
  normalizePullRequestUrl,
  type ProposalStatus,
  readProposalStatus,
} from '../lib/proposal-status.js';
import { assertCanEditWikiPage } from './page-protection-service.js';
import { assertExpectedRevision, saveWithExpectedRevision } from './revision-precondition.js';
import { ensureNonEmptyString, normalizeSlugInput } from './validation.js';
import {
  findCurrentPageBySlugOrAlias,
  readWikiPage,
  recordProtectedWikiPageEdit,
  type WikiPageResult,
} from './wiki-page-service.js';

// How far up the chain of main proposals we look when checking for loops.
const MAX_PARENT_DEPTH = 10;

export interface ProposalLinksInput {
  slug: string;
  // Omitted: unchanged. Empty list: removes all links.
  pullRequests?: string[] | null;
  // Omitted: unchanged. null or empty: removes the main proposal.
  parent?: string | null;
  expectedRevId?: string;
  revSummary?: Record<string, string | null> | null;
}

export interface ProposalPart {
  slug: string;
  title: Record<string, string> | null;
  status: ProposalStatus | null;
}

/**
 * Set the pull requests implementing a proposal and the main proposal it is
 * part of. Anyone who can edit the proposal page can change them; the change
 * is a normal page revision.
 */
export async function setProposalLinks(
  dalInstance: DataAccessLayer,
  input: ProposalLinksInput,
  userId: string
): Promise<WikiPageResult> {
  const errors = new ValidationCollector('Invalid proposal links input.');
  const normalizedSlug = normalizeSlugInput(input.slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);

  let pullRequests: string[] | undefined;
  if (input.pullRequests !== undefined) {
    const items = (input.pullRequests ?? []).map(item => item.trim()).filter(Boolean);
    pullRequests = [];
    items.forEach((item, index) => {
      const url = normalizePullRequestUrl(item);
      if (!url) {
        errors.add(
          `pullRequests.${index}`,
          'must be a pull request on github.com/permacommons/agpwiki.',
          'invalid'
        );
      } else if (!pullRequests?.includes(url)) {
        pullRequests?.push(url);
      }
    });
    if (pullRequests.length > MAX_PULL_REQUESTS) {
      errors.add('pullRequests', `must list ${MAX_PULL_REQUESTS} pull requests or fewer.`, 'max_length');
    }
  }
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, { slug: normalizedSlug });
  }
  const fieldErrors = new ValidationCollector('Invalid proposal links input.');
  if (!isProposalSlug(page.slug)) {
    fieldErrors.add('slug', 'must be a proposal under meta/proposals/.', 'invalid');
    fieldErrors.throwIfAny();
  }
  const protection = await assertCanEditWikiPage(dalInstance, page, userId);
  assertExpectedRevision(page._revID, input.expectedRevId);

  let parent: string | null | undefined;
  if (input.parent !== undefined) {
    const target = input.parent?.trim();
    if (!target) {
      parent = null;
    } else {
      const parentPage = await findCurrentPageBySlugOrAlias(target);
      if (!parentPage || !isProposalSlug(parentPage.slug) || parentPage.id === page.id) {
        fieldErrors.add('parent', 'must name another proposal under meta/proposals/.', 'invalid');
      } else if (await leadsBackTo(parentPage.properties, page.slug)) {
        fieldErrors.add('parent', 'would make the proposal part of itself.', 'invalid');
      } else {
        parent = parentPage.slug;
      }
    }
  }
  fieldErrors.throwIfAny();

  const properties = { ...((page.properties as Record<string, unknown> | null) ?? {}) };
  const proposal = { ...((properties.proposal as Record<string, unknown> | undefined) ?? {}) };
  if (pullRequests !== undefined) {
    if (pullRequests.length) proposal.pullRequests = pullRequests;
    else delete proposal.pullRequests;
  }
  if (parent !== undefined) {
    if (parent) proposal.parent = parent;
    else delete proposal.parent;
  }
  if (Object.keys(proposal).length) properties.proposal = proposal;
  else delete properties.proposal;

  await page.newRevision({ id: userId }, { tags: ['proposal-links'] });
  page.properties = properties;
  page._revSummary = sanitizeLocalizedMapInput(input.revSummary ?? undefined) ?? {
    en: 'Proposal links updated',
  };
  page.updatedAt = new Date();
  await saveWithExpectedRevision(page, input.expectedRevId);
  if (protection) {
    await recordProtectedWikiPageEdit(dalInstance, page, userId, 'proposal-links');
  }

  return readWikiPage(dalInstance, page.slug);
}

const leadsBackTo = async (properties: unknown, slug: string) => {
  let current = properties;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
    const parent = (current as { proposal?: { parent?: unknown } } | null)?.proposal?.parent;
    if (typeof parent !== 'string' || !parent) return false;
    if (parent === slug) return true;
    const next = await findCurrentPageBySlugOrAlias(parent);
    if (!next) return false;
    current = next.properties;
  }
  return false;
};

/**
 * The proposals that name this one as their main proposal, with their status.
 */
export async function listProposalParts(
  dalInstance: DataAccessLayer,
  slug: string
): Promise<ProposalPart[]> {
  const result = await dalInstance.query(
    `SELECT slug, title, properties FROM pages
      WHERE _old_rev_of IS NULL AND _rev_deleted = false
        AND properties->'proposal'->>'parent' = $1
      ORDER BY slug`,
    [slug]
  );
  return (
    result.rows as Array<{ slug: string; title: Record<string, string> | null; properties: unknown }>
  ).map(row => ({
    slug: row.slug,
    title: row.title,
    status: readProposalStatus(row.properties)?.status ?? null,
  }));
}
