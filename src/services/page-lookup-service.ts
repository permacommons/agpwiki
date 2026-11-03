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

  const alias = await PageAlias.filterWhere({ slug }).first();
  if (!alias) return null;

  return findCurrentPageById(alias.pageId);
};

export const findCurrentPageIdBySlug = async (slug: string) =>
  (await findCurrentPageBySlugOrAlias(slug))?.id ?? null;
