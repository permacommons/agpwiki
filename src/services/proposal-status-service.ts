import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import { ForbiddenError, NotFoundError, ValidationCollector } from '../lib/errors.js';
import { sanitizeLocalizedMapInput } from '../lib/localized.js';
import {
  DECISION_STATUSES,
  isProposalSlug,
  isProposalStatus,
  PROPOSAL_PAGE_PREFIX,
  PROPOSAL_STATUSES,
  type ProposalStatus,
  type ProposalStatusInfo,
  readProposalLinks,
  readProposalStatus,
} from '../lib/proposal-status.js';
import { assertCanEditWikiPage } from './page-protection-service.js';
import { assertExpectedRevision, saveWithExpectedRevision } from './revision-precondition.js';
import { userHasRole, WIKI_ADMIN_ROLE } from './roles.js';
import { ensureNonEmptyString, normalizeSlugInput } from './validation.js';
import {
  findCurrentPageBySlugOrAlias,
  readWikiPage,
  type WikiPageResult,
} from './wiki-page-service.js';

export const PROPOSAL_DECISION_NOTE_MAX_LENGTH = 2000;

export interface ProposalStatusInput {
  slug: string;
  status: string;
  decisionNote?: Record<string, string | null> | null;
  appliedTo?: string[] | null;
  supersededBy?: string | null;
  expectedRevId?: string;
  revSummary?: Record<string, string | null> | null;
}

const findProposalCreator = async (dalInstance: DataAccessLayer, pageId: string) => {
  const result = await dalInstance.query(
    'SELECT _rev_user FROM pages WHERE id = $1 OR _old_rev_of = $1 ORDER BY _rev_date ASC LIMIT 1',
    [pageId]
  );
  return (result.rows[0] as { _rev_user: string | null } | undefined)?._rev_user ?? null;
};

export const getProposalStatusPermissions = async (
  dalInstance: DataAccessLayer,
  pageId: string,
  userId: string | null | undefined
) => {
  if (!userId) return { canChange: false, isAdmin: false };
  const isAdmin = await userHasRole(dalInstance, userId, WIKI_ADMIN_ROLE);
  if (isAdmin) return { canChange: true, isAdmin };
  return { canChange: (await findProposalCreator(dalInstance, pageId)) === userId, isAdmin };
};

/**
 * Set the status of a proposal page. Draft, Open and Withdrawn can be set by
 * the proposal's creator or a wiki admin; decisions (Adopted, Applied, Not
 * adopted, Superseded) only by wiki admins and with a decision note. The
 * change is a normal page revision, so it shows in the page history.
 */
export async function setProposalStatus(
  dalInstance: DataAccessLayer,
  input: ProposalStatusInput,
  userId: string
): Promise<WikiPageResult> {
  const errors = new ValidationCollector('Invalid proposal status input.');
  const normalizedSlug = normalizeSlugInput(input.slug, 'slug', errors);
  ensureNonEmptyString(userId, 'userId', errors);
  if (!isProposalStatus(input.status)) {
    errors.add('status', `Must be one of: ${PROPOSAL_STATUSES.join(', ')}.`, 'invalid');
  }
  const decisionNote = Object.fromEntries(
    Object.entries(sanitizeLocalizedMapInput(input.decisionNote ?? undefined) ?? {})
      .map(([lang, text]) => [lang, text.trim()])
      .filter(([, text]) => text.length > 0)
  );
  for (const [lang, text] of Object.entries(decisionNote ?? {})) {
    if (typeof text === 'string' && text.length > PROPOSAL_DECISION_NOTE_MAX_LENGTH) {
      errors.add(`decisionNote.${lang}`, `Must be ${PROPOSAL_DECISION_NOTE_MAX_LENGTH} characters or fewer.`, 'max_length');
    }
  }
  errors.throwIfAny();
  const status = input.status as ProposalStatus;

  const page = await findCurrentPageBySlugOrAlias(normalizedSlug);
  if (!page) {
    throw new NotFoundError(`Wiki page not found: ${normalizedSlug}`, { slug: normalizedSlug });
  }
  if (!isProposalSlug(page.slug)) {
    throw new ForbiddenError('Only pages under meta/proposals/ have a proposal status.', {
      slug: page.slug,
    });
  }
  assertExpectedRevision(page._revID, input.expectedRevId);
  await assertCanEditWikiPage(dalInstance, page, userId);

  const isAdmin = await userHasRole(dalInstance, userId, WIKI_ADMIN_ROLE);
  const isDecision = DECISION_STATUSES.includes(status);
  if (isDecision && !isAdmin) {
    throw new ForbiddenError('Only wiki admins can record a decision on a proposal.', {
      slug: page.slug,
      status,
    });
  }
  if (!isDecision && !isAdmin && (await findProposalCreator(dalInstance, page.id)) !== userId) {
    throw new ForbiddenError(
      'Only the proposal’s creator or a wiki admin can change its status.',
      { slug: page.slug, status }
    );
  }

  const current = readProposalStatus(page.properties);
  const links = readProposalLinks(page.properties);
  const now = new Date().toISOString();
  const next: ProposalStatusInfo = { status, changedAt: now, changedBy: userId };
  const hasNote = Boolean(decisionNote && Object.keys(decisionNote).length);
  const fieldErrors = new ValidationCollector('Invalid proposal status input.');

  if (isDecision) {
    const carriesDecision = status === 'applied' && current?.status === 'adopted';
    if (carriesDecision) {
      next.decidedAt = current?.decidedAt;
      next.decidedBy = current?.decidedBy;
      next.decisionNote = hasNote ? (decisionNote as Record<string, string>) : current?.decisionNote;
    } else if (!hasNote) {
      fieldErrors.add('decisionNote', 'is required when recording a decision.', 'required');
    } else {
      next.decidedAt = now;
      next.decidedBy = userId;
      next.decisionNote = decisionNote as Record<string, string>;
    }
  }
  if (status === 'applied') {
    const appliedTo = (input.appliedTo ?? []).map(item => item.trim()).filter(Boolean);
    if (!appliedTo.length) {
      fieldErrors.add('appliedTo', 'must name the pages changed or the pull requests merged.', 'required');
    }
    next.appliedAt = now;
    next.appliedTo = appliedTo;
  }
  if (status === 'superseded') {
    const target = input.supersededBy?.trim();
    const targetPage = target ? await findCurrentPageBySlugOrAlias(target) : null;
    if (!targetPage || !isProposalSlug(targetPage.slug) || targetPage.id === page.id) {
      fieldErrors.add('supersededBy', 'must name another proposal under meta/proposals/.', 'invalid');
    } else {
      next.supersededBy = targetPage.slug;
    }
  }
  fieldErrors.throwIfAny();

  await page.newRevision({ id: userId }, { tags: ['proposal-status'] });
  page.properties = {
    ...((page.properties as Record<string, unknown> | null) ?? {}),
    proposal: {
      ...next,
      ...(links?.pullRequests.length ? { pullRequests: links.pullRequests } : {}),
      ...(links?.parentId ? { parentId: links.parentId } : {}),
    },
  };
  page._revSummary = sanitizeLocalizedMapInput(input.revSummary ?? undefined) ?? {
    en: `Proposal status: ${status.replace('_', ' ')}`,
  };
  page.updatedAt = new Date();
  await saveWithExpectedRevision(page, input.expectedRevId);

  return readWikiPage(dalInstance, page.slug);
}

export interface ProposalListItem {
  slug: string;
  title: Record<string, string> | null;
  status: ProposalStatus | null;
  updatedAt: Date | null;
}

// Order of the groups on the Proposals list: what needs attention first.
export const PROPOSAL_LIST_ORDER: Array<ProposalStatus | null> = [
  'open',
  'adopted',
  'draft',
  null,
  'applied',
  'not_adopted',
  'withdrawn',
  'superseded',
];

/** Every current page under meta/proposals/, with its status. */
export async function listProposalPages(dalInstance: DataAccessLayer): Promise<ProposalListItem[]> {
  const result = await dalInstance.query(
    `SELECT slug, title, properties, updated_at FROM pages
      WHERE _old_rev_of IS NULL AND _rev_deleted = false AND slug LIKE $1
      ORDER BY slug`,
    [`${PROPOSAL_PAGE_PREFIX}%`]
  );
  return (
    result.rows as Array<{
      slug: string;
      title: Record<string, string> | null;
      properties: unknown;
      updated_at: Date | null;
    }>
  ).map(row => ({
    slug: row.slug,
    title: row.title,
    status: readProposalStatus(row.properties)?.status ?? null,
    updatedAt: row.updated_at,
  }));
}
