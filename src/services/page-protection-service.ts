import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError, NotFoundError, ValidationCollector } from '../lib/errors.js';
import type { PageProtectionInstance } from '../models/manifests/page-protection.js';
import type { WikiPageInstance } from '../models/manifests/wiki-page.js';
import PageAlias from '../models/page-alias.js';
import PageProtection from '../models/page-protection.js';
import WikiPage from '../models/wiki-page.js';
import {
  ADMIN_EVENT_TARGET_WIKI_PAGE,
  ADMIN_EVENT_WIKI_PAGE_PROTECTED,
  ADMIN_EVENT_WIKI_PAGE_UNPROTECTED,
  recordAdminEvent,
} from './admin-event-service.js';
import { assertCanProtectWikiPage } from './authorization.js';
import { userHasRole, WIKI_ADMIN_ROLE } from './roles.js';
import { ensureNonEmptyString, ensureOptionalString, normalizeSlugInput } from './validation.js';

export interface PageProtectionResult {
  id: string;
  pageId: string;
  protectedAt: Date | null | undefined;
  protectedBy: string | null | undefined;
  reason: string | null | undefined;
}

export interface PageEditabilityResult {
  isProtected: boolean;
  isEditable: boolean;
  protection: PageProtectionResult | null;
}

export interface PageProtectionInput {
  slug: string;
  reason?: string | null;
}

const toPageProtectionResult = (protection: PageProtectionInstance): PageProtectionResult => ({
  id: protection.id,
  pageId: protection.pageId,
  protectedAt: protection.protectedAt ?? null,
  protectedBy: protection.protectedBy ?? null,
  reason: protection.reason ?? null,
});

export const getPageProtectionForPage = async (
  _dalInstance: DataAccessLayer,
  pageId: string
): Promise<PageProtectionResult | null> => {
  const protection = await PageProtection.filterWhere({ pageId }).first();
  return protection ? toPageProtectionResult(protection) : null;
};

export const getWikiPageEditability = async (
  dalInstance: DataAccessLayer,
  page: WikiPageInstance | { id: string },
  userId?: string | null
): Promise<PageEditabilityResult> => {
  const protection = await getPageProtectionForPage(dalInstance, page.id);
  if (!protection) {
    return {
      isProtected: false,
      isEditable: Boolean(userId),
      protection: null,
    };
  }

  const isEditable = userId ? await userHasRole(dalInstance, userId, WIKI_ADMIN_ROLE) : false;
  return {
    isProtected: true,
    isEditable,
    protection,
  };
};

export const assertCanEditWikiPage = async (
  dalInstance: DataAccessLayer,
  page: WikiPageInstance,
  userId: string
): Promise<PageProtectionResult | null> => {
  ensureNonEmptyString(userId, 'userId');
  const editability = await getWikiPageEditability(dalInstance, page, userId);
  if (!editability.isProtected) return null;
  if (editability.isEditable) return editability.protection;

  throw new ForbiddenError('Wiki page is protected and can only be edited by wiki admins.', {
    slug: page.slug,
    pageId: page.id,
  });
};

const findCurrentPageBySlug = async (slug: string) =>
  WikiPage.filterWhere({
    slug,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findCurrentPageById = async (id: string) =>
  WikiPage.filterWhere({
    id,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findPageForProtection = async (slug: string) => {
  const direct = await findCurrentPageBySlug(slug);
  const page = direct
    ? direct
    : await (async () => {
        const alias = await PageAlias.filterWhere({ slug }).first();
        return alias ? findCurrentPageById(alias.pageId) : null;
      })();
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${slug}`, { slug });
  }
  return page;
};

export const protectWikiPage = async (
  dalInstance: DataAccessLayer,
  { slug, reason }: PageProtectionInput,
  userId: string
): Promise<PageProtectionResult> => {
  const errors = new ValidationCollector('Invalid page protection input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalString(reason, 'reason', errors);
  errors.throwIfAny();

  await assertCanProtectWikiPage(dalInstance, userId);
  const page = await findPageForProtection(normalizedSlug);
  const existing = await PageProtection.filterWhere({ pageId: page.id }).first();
  const normalizedReason = reason?.trim() ? reason.trim() : null;

  if (existing) {
    existing.protectedBy = userId;
    existing.protectedAt = new Date();
    existing.reason = normalizedReason;
    await existing.save();
    return toPageProtectionResult(existing);
  }

  const protection = await PageProtection.create({
    pageId: page.id,
    protectedAt: new Date(),
    protectedBy: userId,
    reason: normalizedReason,
  });

  await recordAdminEvent(dalInstance, {
    eventType: ADMIN_EVENT_WIKI_PAGE_PROTECTED,
    actorUserId: userId,
    targetType: ADMIN_EVENT_TARGET_WIKI_PAGE,
    targetId: page.id,
    targetRevId: page._revID,
    details: {
      reason: normalizedReason,
      previousProtection: false,
      nextProtection: true,
    },
  });

  return toPageProtectionResult(protection);
};

export const unprotectWikiPage = async (
  dalInstance: DataAccessLayer,
  { slug, reason }: PageProtectionInput,
  userId: string
): Promise<PageProtectionResult | null> => {
  const errors = new ValidationCollector('Invalid page protection input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalString(reason, 'reason', errors);
  errors.throwIfAny();

  await assertCanProtectWikiPage(dalInstance, userId);
  const page = await findPageForProtection(normalizedSlug);
  const existing = await PageProtection.filterWhere({ pageId: page.id }).first();
  if (!existing) return null;

  const result = toPageProtectionResult(existing);
  await existing.delete();

  const normalizedReason = reason?.trim() ? reason.trim() : null;
  await recordAdminEvent(dalInstance, {
    eventType: ADMIN_EVENT_WIKI_PAGE_UNPROTECTED,
    actorUserId: userId,
    targetType: ADMIN_EVENT_TARGET_WIKI_PAGE,
    targetId: page.id,
    targetRevId: page._revID,
    details: {
      reason: normalizedReason,
      previousProtection: true,
      nextProtection: false,
    },
  });

  return result;
};
