import type { Express, Request, Response } from 'express';
import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '../lib/errors.js';
import { forumCategoryPagePath } from '../lib/forum-paths.js';
import { normalizeLineEndings } from '../lib/text-normalization.js';
import { escapeHtml, formatDateUTC, prepareTitle } from '../render.js';
import {
  planRevert,
  type RevertAction,
  type RevertPlan,
  restoreWikiPageRevision,
  rollbackWikiPage,
} from '../services/page-revert-service.js';
import { prependAccountBanner } from './lib/account-banner.js';
import { slugPath } from './lib/canonical.js';
import { fetchUserMap } from './lib/history.js';

const { mlString } = dal;

export const REVERT_PATH = '/tool/revert';

const isEditWarGuard = (error: unknown) =>
  error instanceof ConflictError && (error.details as { reason?: string } | undefined)?.reason === 'edit_war_guard';

const discussionPath = (slug: string) =>
  forumCategoryPagePath(slug.startsWith('meta/') ? 'policy' : 'articles', slug);

const readRequest = (source: Record<string, unknown>) => {
  const slug = typeof source.page === 'string' ? source.page : '';
  const action: RevertAction = source.action === 'rollback' ? 'rollback' : 'restore';
  const revId = typeof source.rev === 'string' ? source.rev : undefined;
  return { slug, action, revId };
};

const render = (req: Request, res: Response, status: number, titleKey: string, bodyHtml: string) => {
  res.status(status).render('layout', {
    title: prepareTitle(req.t(titleKey)),
    labelHtml: `<div class="page-label">${escapeHtml(req.t('label.tool'))}</div>`,
    bodyHtml: `<div class="tool-page revert-page">${bodyHtml}</div>`,
    topHtml: prependAccountBanner(res),
  });
};

const renderGuard = (req: Request, res: Response, slug: string) =>
  render(
    req,
    res,
    409,
    'revert.guard.title',
    `<h2>${escapeHtml(req.t('revert.guard.title'))}</h2>
  <p>${escapeHtml(req.t('revert.guard.body'))}</p>
  <p><a href="${escapeHtml(discussionPath(slug))}">${escapeHtml(req.t('revert.guard.discuss'))}</a> · <a href="/meta/conduct">${escapeHtml(
      req.t('revert.guard.conduct')
    )}</a></p>`
  );

const renderForm = async (
  req: Request,
  res: Response,
  plan: RevertPlan,
  { reason = '', errorKey }: { reason?: string; errorKey?: string } = {}
) => {
  const dalInstance = await initializePostgreSQL();
  const userIds = [plan.target.revUser, ...plan.revertedUserIds].filter((id): id is string => Boolean(id));
  const userMap = await fetchUserMap(dalInstance, userIds);
  const name = (id: string | null | undefined) => (id ? userMap.get(id) ?? id : req.t('notifications.someone'));
  const slug = plan.current.slug;
  const title = mlString.resolve(res.locals.locale ?? 'en', plan.current.title ?? null)?.str ?? slug;
  const diffHref = `${slugPath(slug)}?diffFrom=${encodeURIComponent(plan.target.revId)}&diffTo=${encodeURIComponent(
    plan.current.revId
  )}`;
  const undoneNames = [...new Set(plan.undone.map(item => name(item.revUser)))].join(', ');
  const titleKey = plan.action === 'rollback' ? 'revert.rollback.title' : 'revert.restore.title';
  render(
    req,
    res,
    errorKey ? 400 : 200,
    titleKey,
    `<h2>${escapeHtml(req.t(titleKey))}: <a href="${escapeHtml(slugPath(slug))}">${escapeHtml(title)}</a></h2>
  <p>${escapeHtml(
    req.t('revert.summary', {
      date: formatDateUTC(plan.target.revDate),
      name: name(plan.target.revUser),
      count: plan.undone.length,
      names: undoneNames,
    })
  )} <a href="${escapeHtml(diffHref)}">${escapeHtml(req.t('revert.seeChanges'))}</a></p>
  ${errorKey ? `<div class="form-error" role="alert">${escapeHtml(req.t(errorKey))}</div>` : ''}
  <form class="form-card revert-form" method="post" action="${REVERT_PATH}">
    <input type="hidden" name="page" value="${escapeHtml(slug)}" />
    <input type="hidden" name="action" value="${plan.action}" />
    ${plan.action === 'restore' ? `<input type="hidden" name="rev" value="${escapeHtml(plan.target.revId)}" />` : ''}
    <input type="hidden" name="expectedRevId" value="${escapeHtml(plan.current.revId)}" />
    <label class="form-field">
      <span>${escapeHtml(req.t('revert.reason'))}</span>
      <textarea name="reason" rows="3" required maxlength="300">${escapeHtml(reason)}</textarea>
    </label>
    <p class="form-help">${escapeHtml(req.t('revert.reasonHelp'))}</p>
    <button type="submit">${escapeHtml(req.t(plan.action === 'rollback' ? 'revert.rollback.submit' : 'revert.restore.submit'))}</button>
  </form>`
  );
};

const handleError = (req: Request, res: Response, slug: string, error: unknown) => {
  if (isEditWarGuard(error)) {
    renderGuard(req, res, slug);
    return;
  }
  if (error instanceof NotFoundError) {
    res.status(404).type('text').send(req.t('page.notFound'));
    return;
  }
  if (error instanceof ForbiddenError) {
    res.status(403).type('text').send(req.t('revert.forbidden'));
    return;
  }
  if (error instanceof InvalidRequestError) {
    res.status(400).type('text').send(req.t('revert.invalid'));
    return;
  }
  console.error('Failed to revert:', error);
  res.status(500).type('text').send(req.t('page.serverError'));
};

export const registerRevertRoutes = (app: Express) => {
  app.get(REVERT_PATH, async (req, res) => {
    const { slug, action, revId } = readRequest(req.query as Record<string, unknown>);
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
      return;
    }
    try {
      const dalInstance = await initializePostgreSQL();
      const plan = await planRevert(dalInstance, { slug, action, revId }, session.userId);
      await renderForm(req, res, plan);
    } catch (error) {
      handleError(req, res, slug, error);
    }
  });

  app.post(REVERT_PATH, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { slug, action, revId } = readRequest(body);
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(303, `/tool/login?redirect=${encodeURIComponent(req.originalUrl || req.url)}`);
      return;
    }
    const reason = normalizeLineEndings(typeof body.reason === 'string' ? body.reason : '').trim();
    const expectedRevId = typeof body.expectedRevId === 'string' ? body.expectedRevId : undefined;
    const lang = (res.locals.locale as string | undefined) ?? 'en';
    const dalInstance = await initializePostgreSQL();
    try {
      const input = { slug, revSummary: { [lang]: reason }, expectedRevId };
      const result =
        action === 'rollback'
          ? await rollbackWikiPage(dalInstance, input, session.userId)
          : await restoreWikiPageRevision(dalInstance, { ...input, revId: revId ?? '' }, session.userId);
      res.redirect(303, slugPath(result.page.slug));
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof PreconditionFailedError ||
        (error instanceof ConflictError && !isEditWarGuard(error))
      ) {
        try {
          const plan = await planRevert(dalInstance, { slug, action, revId }, session.userId);
          await renderForm(req, res, plan, {
            reason,
            errorKey: error instanceof ValidationError ? 'revert.reasonRequired' : 'revert.changed',
          });
        } catch (planError) {
          handleError(req, res, slug, planError);
        }
        return;
      }
      handleError(req, res, slug, error);
    }
  });
};
