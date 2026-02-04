import type { Express, Response } from 'express';
import type { TFunction } from 'i18next';

import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { createAltchaChallenge, isAltchaEnabled, verifyAltchaSolution } from '../lib/altcha.js';
import { getUserRoles, hasRole, SITE_ADMIN_ROLE } from '../mcp/roles.js';
import AccountRequest from '../models/account-request.js';
import { escapeHtml, formatDateUTC, renderLayout } from '../render.js';

const renderToolLayout = (
  t: TFunction,
  res: Response,
  title: string,
  bodyHtml: string,
  signedIn = false
) =>
  renderLayout({
    title,
    labelHtml: `<div class="page-label">${t('label.tool')}</div>`,
    bodyHtml,
    signedIn,
    locale: res.locals.locale,
    languageOptions: res.locals.languageOptions,
  });

export const registerAccountRequestRoutes = (app: Express) => {
  app.get('/tool/altcha-challenge', async (_req, res) => {
    const challenge = await createAltchaChallenge();
    res.json(challenge);
  });

  app.get('/tool/request-account', async (req, res) => {
    const altchaEnabled = isAltchaEnabled();
    const altchaWidget = altchaEnabled
      ? `<altcha-widget challengeurl="/tool/altcha-challenge"></altcha-widget>
<script async defer src="https://cdn.jsdelivr.net/npm/altcha/dist/altcha.min.js" type="module"></script>`
      : '';

    const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    <p class="form-help">${req.t('accountRequest.description')}</p>
    <label class="form-field">
      <span>${req.t('accountRequest.form.email')}</span>
      <input type="email" name="email" autocomplete="email" required />
      <div class="form-hint">${req.t('accountRequest.form.emailHint')}</div>
    </label>
    <label class="form-field">
      <span>${req.t('accountRequest.form.topics')}</span>
      <input type="text" name="topics" required />
      <div class="form-hint">${req.t('accountRequest.form.topicsHint')}</div>
    </label>
    <label class="form-field">
      <span>${req.t('accountRequest.form.workedOn')}</span>
      <textarea name="workedOn" rows="4" required></textarea>
      <div class="form-hint">${req.t('accountRequest.form.workedOnHint')}</div>
    </label>
    ${altchaWidget}
    <div class="form-actions">
      <button type="submit">${req.t('accountRequest.submit')}</button>
    </div>
  </form>
</div>`;

    res
      .type('html')
      .send(renderToolLayout(req.t, res, req.t('accountRequest.title'), bodyHtml, false));
  });

  app.post('/tool/request-account', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const topics = String(req.body.topics ?? '').trim();
    const workedOn = String(req.body.workedOn ?? '').trim();
    const altchaPayload = String(req.body.altcha ?? '');

    const altchaValid = await verifyAltchaSolution(altchaPayload);
    if (!altchaValid) {
      const altchaEnabled = isAltchaEnabled();
      const altchaWidget = altchaEnabled
        ? `<altcha-widget challengeurl="/tool/altcha-challenge"></altcha-widget>
<script async defer src="https://cdn.jsdelivr.net/npm/altcha/dist/altcha.min.js" type="module"></script>`
        : '';

      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    <div class="form-error">Please complete the verification challenge.</div>
    <p class="form-help">${req.t('accountRequest.description')}</p>
    <label class="form-field">
      <span>${req.t('accountRequest.form.email')}</span>
      <input type="email" name="email" autocomplete="email" required value="${escapeHtml(email)}" />
      <div class="form-hint">${req.t('accountRequest.form.emailHint')}</div>
    </label>
    <label class="form-field">
      <span>${req.t('accountRequest.form.topics')}</span>
      <input type="text" name="topics" required value="${escapeHtml(topics)}" />
      <div class="form-hint">${req.t('accountRequest.form.topicsHint')}</div>
    </label>
    <label class="form-field">
      <span>${req.t('accountRequest.form.workedOn')}</span>
      <textarea name="workedOn" rows="4" required>${escapeHtml(workedOn)}</textarea>
      <div class="form-hint">${req.t('accountRequest.form.workedOnHint')}</div>
    </label>
    ${altchaWidget}
    <div class="form-actions">
      <button type="submit">${req.t('accountRequest.submit')}</button>
    </div>
  </form>
</div>`;

      res
        .type('html')
        .send(renderToolLayout(req.t, res, req.t('accountRequest.title'), bodyHtml, false));
      return;
    }

    const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || null;
    const userAgent = req.headers['user-agent'] || null;

    await AccountRequest.create({
      email,
      topics,
      workedOn,
      ipAddress,
      userAgent,
      createdAt: new Date(),
    });

    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <h2>${req.t('accountRequest.success.title')}</h2>
    <p>${req.t('accountRequest.success.message')}</p>
  </div>
</div>`;

    res
      .type('html')
      .send(renderToolLayout(req.t, res, req.t('accountRequest.success.title'), bodyHtml, false));
  });

  app.get('/tool/review-requests', async (req, res) => {
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(302, '/tool/auth/login?redirect=/tool/review-requests');
      return;
    }

    const dalInstance = await initializePostgreSQL();
    const roles = await getUserRoles(dalInstance, session.userId);
    if (!hasRole(roles, SITE_ADMIN_ROLE)) {
      res.status(403).type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('page.forbidden'),
          `<div class="tool-page"><p>${req.t('page.accessDenied')}</p></div>`,
          true
        )
      );
      return;
    }

    const requests = await AccountRequest.findPending();

    const rows = requests.length === 0
      ? `<tr><td colspan="5">${req.t('accountRequest.review.empty')}</td></tr>`
      : requests.map(r => {
          const emailCell = escapeHtml(r.email);
          const topicsCell = r.topics ? escapeHtml(r.topics) : '';
          const workedOnCell = r.workedOn ? escapeHtml(r.workedOn) : '';
          const submittedCell = r.createdAt ? formatDateUTC(r.createdAt) : '';
          return `<tr>
  <td>${emailCell}</td>
  <td>${topicsCell}</td>
  <td>${workedOnCell}</td>
  <td>${submittedCell}</td>
  <td>
    <form method="post" action="/tool/review-requests/delete">
      <input type="hidden" name="requestId" value="${escapeHtml(r.id)}" />
      <button type="submit">${req.t('accountRequest.review.delete')}</button>
    </form>
  </td>
</tr>`;
        }).join('');

    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-help">${req.t('accountRequest.review.description')}</p>
    <table class="token-table">
      <thead>
        <tr>
          <th>${req.t('accountRequest.review.headers.email')}</th>
          <th>${req.t('accountRequest.review.headers.topics')}</th>
          <th>${req.t('accountRequest.review.headers.workedOn')}</th>
          <th>${req.t('accountRequest.review.headers.submitted')}</th>
          <th>${req.t('accountRequest.review.headers.actions')}</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</div>`;

    res
      .type('html')
      .send(renderToolLayout(req.t, res, req.t('accountRequest.review.title'), bodyHtml, true));
  });

  app.post('/tool/review-requests/delete', async (req, res) => {
    const session = await resolveSessionUser(req);
    if (!session) {
      res.redirect(302, '/tool/auth/login?redirect=/tool/review-requests');
      return;
    }

    const dalInstance = await initializePostgreSQL();
    const roles = await getUserRoles(dalInstance, session.userId);
    if (!hasRole(roles, SITE_ADMIN_ROLE)) {
      res.status(403).type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('page.forbidden'),
          `<div class="tool-page"><p>${req.t('page.accessDenied')}</p></div>`,
          true
        )
      );
      return;
    }

    const requestId = String(req.body.requestId ?? '').trim();
    if (requestId) {
      const accountRequest = await AccountRequest.filterWhere({ id: requestId }).first();
      if (accountRequest && !accountRequest.deletedAt) {
        accountRequest.deletedAt = new Date();
        accountRequest.deletedBy = session.userId;
        await accountRequest.save();
      }
    }

    res.redirect(302, '/tool/review-requests');
  });
};
