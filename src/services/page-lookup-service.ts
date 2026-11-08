import { isUuid } from '../lib/uuid.js';
import PageAlias from '../models/page-alias.js';
import WikiPage from '../models/wiki-page.js';

export const findCurrentPageBySlug = async (slug: string) =>
  WikiPage.filterWhere({
    slug,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

export const findCurrentPageById = async (id: string) =>
  WikiPage.filterWhere({
    id,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

export const findCurrentPageBySlugOrAlias = async (slug: string) => {
  const direct = await findCurrentPageBySlug(slug);
  if (direct) return direct;

  const alias = await PageAlias.filterWhere({ slug }).select('pageId').first();
  if (!alias) return null;

  return findCurrentPageById(alias.pageId);
};

export const findCurrentPageIdBySlug = async (slug: string) => {
  const direct = await WikiPage.filterWhere({ slug }).select('id').first();
  if (direct) return direct.id;
  const alias = await PageAlias.filterWhere({ slug }).select('pageId').first();
  if (!alias) return null;
  return (await WikiPage.filterWhere({ id: alias.pageId }).select('id').first())?.id ?? null;
};

/**
 * A page's permanent ID names it as well as its address does. Returns the
 * current address of the page with that ID, or the value unchanged when it
 * is not the ID of a current page, so it is read as an address.
 */
export const resolvePageSlugOrId = async (value: string) => {
  if (!isUuid(value)) return value;
  return (await WikiPage.filterWhere({ id: value.toLowerCase() }).select('slug').first())?.slug ?? value;
};
