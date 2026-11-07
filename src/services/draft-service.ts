import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  ValidationCollector,
} from '../lib/errors.js';
import type { LocalizedMapInput } from '../lib/localized.js';
import { resolvePageAddress } from '../lib/page-address.js';
import PageAlias from '../models/page-alias.js';
import { checkNewPage } from './duplicate-check-service.js';
import { isExperiencedEditor } from './experienced-editor-service.js';
import { findCurrentPageBySlug, findCurrentPageBySlugOrAlias } from './page-lookup-service.js';
import { userHasRole, WIKI_ADMIN_ROLE } from './roles.js';
import { ensureNonEmptyString, normalizeSlugInput } from './validation.js';
import { updateWikiPage, type WikiPageResult } from './wiki-page-service.js';

// A draft published this soon after it was created was checked for
// duplicates moments ago, so it is not checked again.
export const DRAFT_DUPLICATE_RECHECK_AFTER_MS = 60 * 60 * 1000;

export const DRAFT_PUBLISH_TAG = 'publish';

export interface PublishDraftInput {
  slug: string;
  notDuplicateOf?: string[];
  expectedRevId?: string;
  tags?: string[];
  revSummary: LocalizedMapInput;
}

export interface PublishDraftResult extends WikiPageResult {
  draftSlug: string;
}

const findPageCreator = async (dalInstance: DataAccessLayer, pageId: string) => {
  const result = await dalInstance.query(
    'SELECT _rev_user FROM pages WHERE id = $1 OR _old_rev_of = $1 ORDER BY _rev_date ASC LIMIT 1',
    [pageId]
  );
  return (result.rows[0] as { _rev_user: string | null } | undefined)?._rev_user ?? null;
};

/** The draft's creator, experienced editors and wiki admins may publish it. */
export const canPublishDraft = async (
  dalInstance: DataAccessLayer,
  pageId: string,
  userId: string | null | undefined
): Promise<boolean> => {
  if (!userId) return false;
  if (await userHasRole(dalInstance, userId, WIKI_ADMIN_ROLE)) return true;
  if ((await findPageCreator(dalInstance, pageId)) === userId) return true;
  return isExperiencedEditor(dalInstance, userId);
};

/**
 * Moves a draft to its article address (draft/<name> to <name>). The draft
 * address stays as an alias, so links to it lead to the article.
 */
export async function publishDraft(
  dalInstance: DataAccessLayer,
  { slug, notDuplicateOf, expectedRevId, tags = [], revSummary }: PublishDraftInput,
  userId: string
): Promise<PublishDraftResult> {
  const errors = new ValidationCollector('Invalid draft publish input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  errors.throwIfAny();

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, { slug: normalizedSlug });
  }
  const address = resolvePageAddress(page.slug);
  if (address?.namespace !== 'draft') {
    throw new InvalidRequestError(`Not a draft: ${page.slug}`, { slug: page.slug });
  }
  const target = address.localName;
  if (resolvePageAddress(target)?.namespace !== 'article') {
    throw new InvalidRequestError(`Only articles can be drafts: ${page.slug}`, { slug: page.slug });
  }
  if (!(await canPublishDraft(dalInstance, page.id, userId))) {
    throw new ForbiddenError(
      'Publishing a draft is limited to its creator, experienced editors and wiki admins.'
    );
  }
  const takenAlias = await PageAlias.filterWhere({ slug: target }).first();
  if ((await findCurrentPageBySlug(target)) || (takenAlias && takenAlias.pageId !== page.id)) {
    throw new ConflictError(`The article address is already taken: ${target}`, {
      slug: page.slug,
      newSlug: target,
    });
  }

  const createdAt = page.createdAt ? new Date(page.createdAt).getTime() : 0;
  const check =
    Date.now() - createdAt < DRAFT_DUPLICATE_RECHECK_AFTER_MS
      ? { tags: [] }
      : await checkNewPage(dalInstance, {
          slug: page.slug,
          title: page.title ?? undefined,
          canonicalLanguage: page.canonicalLanguage ?? null,
          wikidata: (page.properties as { wikidata?: string } | null)?.wikidata ?? null,
          notDuplicateOf,
          excludeSlug: page.slug,
        });

  const result = await updateWikiPage(
    dalInstance,
    {
      slug: page.slug,
      newSlug: target,
      keepAlias: true,
      expectedRevId,
      tags: [DRAFT_PUBLISH_TAG, ...check.tags, ...tags],
      revSummary: revSummary as Record<string, string | null>,
    },
    userId,
    { publishingDraft: true }
  );
  return { ...result, draftSlug: page.slug };
}
