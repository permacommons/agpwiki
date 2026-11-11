import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError, NotFoundError, ValidationCollector } from '../lib/errors.js';
import { isProfileSlug } from '../lib/profile-paths.js';
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
import { isExperiencedEditor } from './experienced-editor-service.js';
import { canEditProfile, findProfileOwnerBySlug } from './profile-service.js';
import { userHasRole, WIKI_ADMIN_ROLE } from './roles.js';
import { ensureNonEmptyString, ensureOptionalString, normalizeSlugInput } from './validation.js';

// Who may edit a protected page: admins only, or experienced editors too.
export const PROTECTION_LEVELS = ['admins', 'experienced'] as const;
export type ProtectionLevel = (typeof PROTECTION_LEVELS)[number];

export const isProtectionLevel = (value: unknown): value is ProtectionLevel =>
  typeof value === 'string' && (PROTECTION_LEVELS as readonly string[]).includes(value);

export interface PageProtectionResult {
  id: string;
  pageId: string;
  protectedAt: Date | null | undefined;
  protectedBy: string | null | undefined;
  reason: string | null | undefined;
  level: ProtectionLevel;
}

export interface PageEditabilityResult {
  isProtected: boolean;
  isEditable: boolean;
  protection: PageProtectionResult | null;
  // Set on a contributor profile: the username of the contributor it belongs to.
  profileOf?: string;
}

export interface PageProtectionInput {
  slug: string;
  reason?: string | null;
  level?: ProtectionLevel;
}

const toPageProtectionResult = (protection: PageProtectionInstance): PageProtectionResult => ({
  id: protection.id,
  pageId: protection.pageId,
  protectedAt: protection.protectedAt ?? null,
  protectedBy: protection.protectedBy ?? null,
  reason: protection.reason ?? null,
  level: isProtectionLevel(protection.level) ? protection.level : 'admins',
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
  page: WikiPageInstance | { id: string; slug?: string },
  userId?: string | null
): Promise<PageEditabilityResult> => {
  const slug = page.slug ?? (await WikiPage.filterWhere({ id: page.id }).select('slug').first())?.slug ?? '';
  const owner = isProfileSlug(slug) ? await findProfileOwnerBySlug(dalInstance, slug) : null;
  const profileOf = owner?.username;
  const protection = await getPageProtectionForPage(dalInstance, page.id);
  // Only its contributor and wiki admins may write a profile.
  if (owner && !(await canEditProfile(dalInstance, owner, userId))) {
    return { isProtected: true, isEditable: false, protection, profileOf };
  }
  if (!protection) {
    return {
      isProtected: Boolean(owner),
      isEditable: Boolean(userId),
      protection: null,
      profileOf,
    };
  }

  const isEditable = userId
    ? (await userHasRole(dalInstance, userId, WIKI_ADMIN_ROLE)) ||
      (protection.level === 'experienced' && (await isExperiencedEditor(dalInstance, userId)))
    : false;
  return {
    isProtected: true,
    isEditable,
    protection,
    profileOf,
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

  if (editability.profileOf) {
    throw new ForbiddenError('Only the contributor and wiki admins can edit this profile.', {
      slug: page.slug,
      pageId: page.id,
      profileOf: editability.profileOf,
    });
  }
  throw new ForbiddenError(
    editability.protection?.level === 'experienced'
      ? 'Wiki page is protected and can only be edited by experienced editors and wiki admins.'
      : 'Wiki page is protected and can only be edited by wiki admins.',
    {
      slug: page.slug,
      pageId: page.id,
      level: editability.protection?.level ?? 'admins',
    }
  );
};

const findCurrentPageBySlug = async (slug: string) =>
  WikiPage.filterWhere({ slug }).select('id', '_revID').first();

const findCurrentPageById = async (id: string) =>
  WikiPage.filterWhere({ id }).select('id', '_revID').first();

const findPageForProtection = async (slug: string) => {
  const direct = await findCurrentPageBySlug(slug);
  const page = direct
    ? direct
    : await (async () => {
        const alias = await PageAlias.filterWhere({ slug }).select('pageId').first();
        return alias ? findCurrentPageById(alias.pageId) : null;
      })();
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${slug}`, { slug });
  }
  return page;
};

export const protectWikiPage = async (
  dalInstance: DataAccessLayer,
  { slug, reason, level = 'admins' }: PageProtectionInput,
  userId: string
): Promise<PageProtectionResult> => {
  const errors = new ValidationCollector('Invalid page protection input.');
  const normalizedSlug = normalizeSlugInput(slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  ensureOptionalString(reason, 'reason', errors);
  if (!isProtectionLevel(level)) errors.add('level', 'must be "admins" or "experienced".', 'invalid');
  errors.throwIfAny();

  await assertCanProtectWikiPage(dalInstance, userId);
  const page = await findPageForProtection(normalizedSlug);
  const existing = await PageProtection.filterWhere({ pageId: page.id }).first();
  const normalizedReason = reason?.trim() ? reason.trim() : null;

  if (existing) {
    const previousLevel = isProtectionLevel(existing.level) ? existing.level : 'admins';
    existing.protectedBy = userId;
    existing.protectedAt = new Date();
    existing.reason = normalizedReason;
    existing.level = level;
    await existing.save();
    if (previousLevel !== level) {
      await recordAdminEvent(dalInstance, {
        eventType: ADMIN_EVENT_WIKI_PAGE_PROTECTED,
        actorUserId: userId,
        targetType: ADMIN_EVENT_TARGET_WIKI_PAGE,
        targetId: page.id,
        targetRevId: page._revID,
        details: { reason: normalizedReason, previousLevel, nextLevel: level },
      });
    }
    return toPageProtectionResult(existing);
  }

  const protection = await PageProtection.create({
    pageId: page.id,
    protectedAt: new Date(),
    protectedBy: userId,
    reason: normalizedReason,
    level,
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
      nextLevel: level,
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
