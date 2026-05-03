import type { Express, Request, Response } from 'express';

import { hashPassword } from '../auth/password.js';
import { createSession, resolveSessionUser, setSessionCookie } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { createAltchaChallenge, isAltchaEnabled, verifyAltchaSolution } from '../lib/altcha.js';
import { isValidUsername, normalizeUsername, trimDisplayName } from '../lib/username.js';
import User from '../models/user.js';
import { escapeHtml, formatDateUTC, prepareTitle } from '../render.js';
import {
  AGENT_ACCESS_GRANTED_NOTICE,
  AGENT_ACCESS_REJECTED_NOTICE,
  approveAgentAccessRequest,
  blockUserAccount,
  dismissUserNotice,
  getAccountLifecycleState,
  normalizeProfileUrl,
  rejectAgentAccessRequest,
  unblockUserAccount,
  upsertAgentAccessRequest,
} from '../services/account-lifecycle.js';
import {
  createEmailVerificationToken,
  sendEmailVerificationEmail,
} from '../services/email-verification.js';
import { consumeRateLimit, getRateLimitKey } from '../services/request-rate-limit.js';
import { getUserRoles, hasRole, SITE_ADMIN_ROLE } from '../services/roles.js';
import { prependAccountBanner } from './lib/account-banner.js';

const ACCOUNT_REVIEW_PATH = '/tool/review-accounts';
const ACCOUNT_REVIEW_PAGE_SIZE = 100;
const ACCOUNT_REVIEW_BULK_FORM_ID = 'account-review-bulk-form';
const DEFAULT_POST_SIGNUP_REDIRECT = '/meta/welcome';
const EMAIL_STATUS_QUERY_KEY = 'email';
const EMAIL_STATUS_UNAVAILABLE = 'unavailable';
const EMAIL_STATUS_RATE_LIMITED = 'rate-limited';

const renderToolLayout = (res: Response, title: string, bodyHtml: string) => {
  res.render('layout', {
    title: prepareTitle(title),
    labelHtml: `<div class="page-label">${res.req.t('label.tool')}</div>`,
    bodyHtml,
    topHtml: prependAccountBanner(res),
  });
};

const renderError = (message: string) =>
  `<div class="form-error">${escapeHtml(message)}</div>`;

const renderAltchaWidget = () =>
  isAltchaEnabled()
    ? `<altcha-widget challengeurl="/tool/altcha-challenge"></altcha-widget>
<script async defer src="https://cdn.jsdelivr.net/npm/altcha/dist/altcha.min.js" type="module"></script>`
    : '';

const renderCreateAccountForm = (
  req: Request,
  values: { displayName?: string; email?: string } = {},
  errorMessage?: string
) => `<div class="tool-page">
  <form method="post" class="form-card">
    ${errorMessage ? renderError(errorMessage) : ''}
    <p class="form-help">${req.t('account.create.description')}</p>
    <label class="form-field">
      <span>${req.t('account.form.username')}</span>
      <input
        type="text"
        name="displayName"
        autocomplete="username"
        required
        value="${escapeHtml(values.displayName ?? '')}"
      />
    </label>
    <label class="form-field">
      <span>${req.t('account.form.email')}</span>
      <input
        type="email"
        name="email"
        autocomplete="email"
        required
        value="${escapeHtml(values.email ?? '')}"
      />
    </label>
    <label class="form-field">
      <span>${req.t('account.form.password')}</span>
      <input type="password" name="password" autocomplete="new-password" required />
    </label>
    ${renderAltchaWidget()}
    <div class="form-actions">
      <button type="submit">${req.t('account.create.submit')}</button>
    </div>
  </form>
</div>`;

const renderCompleteProfileForm = (
  req: Request,
  options: {
    errorMessage?: string;
    emailStatus?: string | null;
    interests?: string;
    profileUrl?: string;
  } = {}
) => {
  const emailStatusField = options.emailStatus
    ? `<input type="hidden" name="${EMAIL_STATUS_QUERY_KEY}" value="${escapeHtml(options.emailStatus)}" />`
    : '';
  return `<div class="tool-page">
  <form method="post" class="form-card">
    ${options.errorMessage ? renderError(options.errorMessage) : ''}
    <p class="form-help">${req.t('account.profile.description')}</p>
    ${emailStatusField}
    <label class="form-field">
      <span>${req.t('account.profile.interests')}</span>
      <input type="text" name="interests" value="${escapeHtml(options.interests ?? '')}" />
      <div class="form-hint">${req.t('account.profile.interestsHint')}</div>
    </label>
    <label class="form-field">
      <span>${req.t('account.profile.profileUrl')}</span>
      <input type="url" name="profileUrl" value="${escapeHtml(options.profileUrl ?? '')}" />
      <div class="form-hint">${req.t('account.profile.profileUrlHint')}</div>
    </label>
    <div class="form-actions">
      <button type="submit" name="action" value="submit">${req.t('account.profile.submit')}</button>
      <button type="submit" name="action" value="skip">${req.t('account.profile.skip')}</button>
    </div>
  </form>
</div>`;
};

const withEmailStatus = (path: string, status: string) => {
  const url = new URL(path, 'http://local');
  url.searchParams.set(EMAIL_STATUS_QUERY_KEY, status);
  return `${url.pathname}${url.search}`;
};

const appendOptionalEmailStatus = (path: string, emailStatus: string | null) =>
  emailStatus ? withEmailStatus(path, emailStatus) : path;

const getReviewPage = (value: unknown) => {
  if (typeof value !== 'string') return 1;
  const page = Number.parseInt(value, 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
};

const getAccountReviewPath = (page: number) => {
  if (page <= 1) return ACCOUNT_REVIEW_PATH;
  return `${ACCOUNT_REVIEW_PATH}?page=${page}`;
};

const appendAccountReviewStatus = (
  redirectTo: string,
  status: { action: string; changed: number; skipped: number }
) => {
  const url = new URL(redirectTo, 'http://local');
  url.searchParams.set('bulkAction', status.action);
  url.searchParams.set('changed', String(status.changed));
  if (status.skipped > 0) {
    url.searchParams.set('skipped', String(status.skipped));
  }
  return `${url.pathname}${url.search}`;
};

const getReviewStatusCount = (value: unknown) => {
  if (typeof value !== 'string') return 0;
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
};

const renderAccountReviewStatus = (req: Request) => {
  const bulkAction = typeof req.query.bulkAction === 'string' ? req.query.bulkAction : '';
  const changed = getReviewStatusCount(req.query.changed);
  const skipped = getReviewStatusCount(req.query.skipped);
  if (bulkAction !== 'block' && bulkAction !== 'unblock') return '';

  const message =
    changed > 0 && bulkAction === 'block'
      ? req.t('account.review.notice.block', { count: changed })
      : changed > 0 && bulkAction === 'unblock'
        ? req.t('account.review.notice.unblock', { count: changed })
        : req.t('account.review.notice.noneSelected');
  const skippedHtml =
    skipped > 0
      ? `<div>${escapeHtml(req.t('account.review.notice.skippedSelf', { count: skipped }))}</div>`
      : '';
  return `<div class="account-review-notice" role="status">
    <div>${escapeHtml(message)}</div>
    ${skippedHtml}
  </div>`;
};

const requireSignedInUser = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(302, '/tool/login?redirect=/tool/complete-profile');
    return null;
  }
  const user = await User.filterWhere({ id: session.userId }).first();
  if (!user) {
    res.redirect(302, '/tool/login');
    return null;
  }
  return user;
};

const requireSiteAdmin = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(302, `/tool/login?redirect=${encodeURIComponent(ACCOUNT_REVIEW_PATH)}`);
    return null;
  }

  const dalInstance = await initializePostgreSQL();
  const roles = await getUserRoles(dalInstance, session.userId);
  if (!hasRole(roles, SITE_ADMIN_ROLE)) {
    res.status(403);
    renderToolLayout(
      res,
      req.t('page.forbidden'),
      `<div class="tool-page"><p>${req.t('page.accessDenied')}</p></div>`
    );
    return null;
  }

  return { session, dalInstance };
};

const renderAccountReviewPage = async (req: Request, res: Response) => {
  const adminContext = await requireSiteAdmin(req, res);
  if (!adminContext) return;

  const { dalInstance } = adminContext;
  const requestedPage = getReviewPage(req.query.page);
  const countResult = await dalInstance.query('SELECT COUNT(*)::int AS total FROM users');
  const totalAccounts = Number(countResult.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalAccounts / ACCOUNT_REVIEW_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * ACCOUNT_REVIEW_PAGE_SIZE;
  const result = await dalInstance.query(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.email,
       u.created_at,
       u.email_verified_at,
       u.blocked_at,
       aar.interests,
       aar.profile_url,
       aar.status AS agent_status,
       aar.submitted_at,
       aar.reviewed_at,
       aar.rejection_reason
     FROM users u
     LEFT JOIN agent_access_requests aar ON aar.user_id = u.id
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [ACCOUNT_REVIEW_PAGE_SIZE, offset]
  );

  const rows = result.rows.length === 0
    ? `<tr><td colspan="7">${req.t('account.review.empty')}</td></tr>`
    : result.rows.map(row => {
        const userId = String(row.id);
        const agentStatus = typeof row.agent_status === 'string' ? row.agent_status : 'none';
        const isEmailVerified = Boolean(row.email_verified_at);
        const profileHtml =
          row.profile_url && typeof row.profile_url === 'string'
            ? `<a href="${escapeHtml(row.profile_url)}" rel="noreferrer noopener">${escapeHtml(
                row.profile_url
              )}</a>`
            : '';
        const rejectionReason =
          row.rejection_reason && typeof row.rejection_reason === 'string'
            ? `<div class="form-hint">${escapeHtml(row.rejection_reason)}</div>`
            : '';
        const reviewActions = agentStatus === 'pending'
          ? `<form method="post" action="${ACCOUNT_REVIEW_PATH}/approve">
  <input type="hidden" name="userId" value="${escapeHtml(userId)}" />
  <button class="account-review-action-button" type="submit">${req.t('account.review.approve')}</button>
</form>
<details class="account-review-action">
  <summary>${req.t('account.review.reject')}</summary>
  <form method="post" action="${ACCOUNT_REVIEW_PATH}/reject">
    <input type="hidden" name="userId" value="${escapeHtml(userId)}" />
    <label class="form-field">
      <span>${req.t('account.review.rejectReason')}</span>
      <input type="text" name="rejectionReason" required />
    </label>
    <button class="account-review-action-button" type="submit">${req.t('account.review.confirm')}</button>
  </form>
</details>`
          : '';
        const blockAction = row.blocked_at
          ? `<span>${req.t('account.review.blocked')}</span>
<form method="post" action="${ACCOUNT_REVIEW_PATH}/unblock">
  <input type="hidden" name="userId" value="${escapeHtml(userId)}" />
  <button class="account-review-action-button" type="submit">${req.t('account.review.unblock')}</button>
</form>`
          : `<details class="account-review-action">
  <summary>${req.t('account.review.block')}</summary>
  <form method="post" action="${ACCOUNT_REVIEW_PATH}/block">
    <input type="hidden" name="userId" value="${escapeHtml(userId)}" />
    <label class="form-field">
      <span>${req.t('account.review.blockReason')}</span>
      <input type="text" name="blockReason" />
    </label>
    <button class="account-review-action-button" type="submit">${req.t('account.review.confirm')}</button>
  </form>
</details>`;
        const actions = `${reviewActions || `<span>${req.t('account.review.noAction')}</span>`}${blockAction}`;

        return `<tr class="account-review-row${row.blocked_at ? ' is-blocked' : ''}">
  <td class="account-review-select-cell" data-label="${escapeHtml(req.t('account.review.headers.select'))}">
    <label class="account-review-checkbox">
      <input
        type="checkbox"
        name="userIds"
        value="${escapeHtml(userId)}"
        form="${ACCOUNT_REVIEW_BULK_FORM_ID}"
        data-account-review-checkbox
        data-email-verified="${isEmailVerified ? 'true' : 'false'}"
      />
      <span>${escapeHtml(req.t('account.review.selectAccount', { username: String(row.username ?? '') }))}</span>
    </label>
  </td>
  <td data-label="${escapeHtml(req.t('account.review.headers.username'))}">
    <div>${escapeHtml(String(row.username ?? ''))}</div>
    <div class="form-hint">${escapeHtml(String(row.display_name ?? ''))}</div>
  </td>
  <td data-label="${escapeHtml(req.t('account.review.headers.email'))}">${escapeHtml(String(row.email ?? ''))}</td>
  <td data-label="${escapeHtml(req.t('account.review.headers.created'))}">${escapeHtml(formatDateUTC(row.created_at as Date | string | null))}</td>
  <td data-label="${escapeHtml(req.t('account.review.headers.emailStatus'))}">${isEmailVerified ? req.t('account.review.verified') : req.t('account.review.unverified')}</td>
  <td data-label="${escapeHtml(req.t('account.review.headers.agentAccess'))}">
    <div>${escapeHtml(req.t(`account.review.status.${agentStatus}`))}</div>
    <div>${escapeHtml(String(row.interests ?? ''))}</div>
    ${profileHtml}
    ${rejectionReason}
  </td>
  <td data-label="${escapeHtml(req.t('account.review.headers.actions'))}"><div class="account-review-actions">${actions}</div></td>
</tr>`;
      }).join('');

  const firstItem = totalAccounts === 0 ? 0 : offset + 1;
  const lastItem = Math.min(offset + result.rows.length, totalAccounts);
  const paginationSummary = req.t('account.review.pagination.summary', {
    start: String(firstItem),
    end: String(lastItem),
    total: String(totalAccounts),
  });
  const paginationControls = `<nav class="account-review-pagination" aria-label="${escapeHtml(req.t('account.review.pagination.label'))}">
    ${page > 1 ? `<a href="${getAccountReviewPath(page - 1)}">${req.t('account.review.pagination.previous')}</a>` : `<span>${req.t('account.review.pagination.previous')}</span>`}
    <span>${escapeHtml(req.t('account.review.pagination.page', { page: String(page), pages: String(totalPages) }))}</span>
    ${page < totalPages ? `<a href="${getAccountReviewPath(page + 1)}">${req.t('account.review.pagination.next')}</a>` : `<span>${req.t('account.review.pagination.next')}</span>`}
  </nav>`;
  const bodyHtml = `<div class="tool-page">
  <div class="form-card" data-account-review-root>
    <p class="form-help">${req.t('account.review.description')}</p>
    ${renderAccountReviewStatus(req)}
    <form id="${ACCOUNT_REVIEW_BULK_FORM_ID}" method="post" action="${ACCOUNT_REVIEW_PATH}/bulk" data-account-review-form>
      <input type="hidden" name="redirectTo" value="${escapeHtml(getAccountReviewPath(page))}" />
    </form>
    <div class="account-review-toolbar">
      <div class="account-review-selection-group">
        <div class="account-review-bulk-label requires-js">${req.t('account.review.selection.heading')}</div>
        <div class="account-review-selection-actions" aria-label="${escapeHtml(req.t('account.review.selection.label'))}">
          <button class="requires-js" type="button" data-account-review-select-all>${req.t('account.review.selection.selectPage')}</button>
          <button class="requires-js" type="button" data-account-review-select-unverified>${req.t('account.review.selection.selectUnverified')}</button>
          <button class="requires-js" type="button" data-account-review-clear>${req.t('account.review.selection.clear')}</button>
          <span
            class="account-review-selected-count requires-js"
            data-account-review-selected-count
            data-selected-count-one="${escapeHtml(req.t('account.review.selection.selectedCount_one'))}"
            data-selected-count-other="${escapeHtml(req.t('account.review.selection.selectedCount_other'))}"
            aria-live="polite"
          >${escapeHtml(req.t('account.review.selection.selectedCount', { count: 0 }))}</span>
        </div>
      </div>
      <div class="account-review-bulk-group">
        <label class="account-review-bulk-label" for="account-review-block-reason">${req.t('account.review.blockReason')}</label>
        <div class="account-review-bulk-actions">
          <input id="account-review-block-reason" type="text" name="blockReason" form="${ACCOUNT_REVIEW_BULK_FORM_ID}" />
          <button type="submit" name="bulkAction" value="block" form="${ACCOUNT_REVIEW_BULK_FORM_ID}">${req.t('account.review.bulk.block')}</button>
          <button type="submit" name="bulkAction" value="unblock" form="${ACCOUNT_REVIEW_BULK_FORM_ID}">${req.t('account.review.bulk.unblock')}</button>
        </div>
      </div>
    </div>
    <div class="account-review-meta">
      <span>${escapeHtml(paginationSummary)}</span>
      ${paginationControls}
    </div>
    <div class="table-stack-mobile">
      <table class="token-table account-review-table">
        <thead>
          <tr>
            <th>
              <label class="account-review-checkbox account-review-checkbox-heading requires-js">
                <input type="checkbox" data-account-review-toggle-page />
                <span>${req.t('account.review.headers.select')}</span>
              </label>
            </th>
            <th>${req.t('account.review.headers.username')}</th>
            <th>${req.t('account.review.headers.email')}</th>
            <th>${req.t('account.review.headers.created')}</th>
            <th>${req.t('account.review.headers.emailStatus')}</th>
            <th>${req.t('account.review.headers.agentAccess')}</th>
            <th>${req.t('account.review.headers.actions')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="account-review-meta account-review-meta-bottom">
      <span>${escapeHtml(paginationSummary)}</span>
      ${paginationControls}
    </div>
  </div>
</div>
<script>
(() => {
  const root = document.querySelector('[data-account-review-root]');
  if (!root) return;
  const checkboxes = [...root.querySelectorAll('[data-account-review-checkbox]')];
  const pageToggle = root.querySelector('[data-account-review-toggle-page]');
  const selectedCount = root.querySelector('[data-account-review-selected-count]');
  const pluralRules = new Intl.PluralRules(document.documentElement.lang || undefined);
  const updateSelectedCount = () => {
    if (!selectedCount) return;
    const count = checkboxes.filter(checkbox => checkbox.checked).length;
    const template =
      pluralRules.select(count) === 'one'
        ? selectedCount.dataset.selectedCountOne
        : selectedCount.dataset.selectedCountOther;
    selectedCount.textContent = (template ?? '').replace('{{count}}', String(count));
  };
  const setChecked = predicate => {
    checkboxes.forEach(checkbox => {
      checkbox.checked = predicate(checkbox);
    });
    if (pageToggle) {
      pageToggle.checked = checkboxes.length > 0 && checkboxes.every(checkbox => checkbox.checked);
    }
    updateSelectedCount();
  };
  root.querySelector('[data-account-review-select-all]')?.addEventListener('click', () => setChecked(() => true));
  root.querySelector('[data-account-review-select-unverified]')?.addEventListener('click', () => setChecked(checkbox => checkbox.dataset.emailVerified !== 'true'));
  root.querySelector('[data-account-review-clear]')?.addEventListener('click', () => setChecked(() => false));
  pageToggle?.addEventListener('change', () => setChecked(() => pageToggle.checked));
  checkboxes.forEach(checkbox => checkbox.addEventListener('change', () => {
    if (pageToggle) {
      pageToggle.checked = checkboxes.length > 0 && checkboxes.every(entry => entry.checked);
    }
    updateSelectedCount();
  }));
  updateSelectedCount();
})();
</script>`;

  renderToolLayout(res, req.t('account.review.title'), bodyHtml);
};

export const registerAccountRequestRoutes = (app: Express) => {
  app.get('/tool/altcha-challenge', async (_req, res) => {
    const challenge = await createAltchaChallenge();
    res.json(challenge);
  });

  app.get('/tool/request-account', async (_req, res) => {
    res.redirect(302, '/tool/create-account');
  });

  app.get('/tool/create-account', async (req, res) => {
    const session = await resolveSessionUser(req);
    if (session) {
      res.redirect(302, '/tool/complete-profile');
      return;
    }

    renderToolLayout(res, req.t('account.create.title'), renderCreateAccountForm(req));
  });

  app.post('/tool/request-account', async (_req, res) => {
    res.redirect(307, '/tool/create-account');
  });

  app.post('/tool/create-account', async (req, res) => {
    const displayName = trimDisplayName(String(req.body.displayName ?? ''));
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');
    const username = normalizeUsername(displayName);
    const altchaPayload = String(req.body.altcha ?? '');
    const signupRateLimit = consumeRateLimit('signup', getRateLimitKey(req, 'signup'));

    if (!signupRateLimit.allowed) {
      res.status(429).set('Retry-After', String(signupRateLimit.retryAfterSeconds));
      renderToolLayout(
        res,
        req.t('account.create.title'),
        renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorRateLimited'))
      );
      return;
    }

    const altchaValid = await verifyAltchaSolution(altchaPayload);
    if (!altchaValid) {
      renderToolLayout(
        res,
        req.t('account.create.title'),
        renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorCaptcha'))
      );
      return;
    }

    if (!displayName || !email || !password || !username) {
      renderToolLayout(
        res,
        req.t('account.create.title'),
        renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorRequired'))
      );
      return;
    }

    if (!isValidUsername(displayName)) {
      renderToolLayout(
        res,
        req.t('account.create.title'),
        renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorUsernameInvalid'))
      );
      return;
    }

    const [existingEmail, existingUsername] = await Promise.all([
      User.filterWhere({ email }).first(),
      User.filterWhere({ username }).first(),
    ]);

    if (existingEmail) {
      renderToolLayout(
        res,
        req.t('account.create.title'),
        renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorEmailUnavailable'))
      );
      return;
    }

    if (existingUsername) {
      renderToolLayout(
        res,
        req.t('account.create.title'),
        renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorUsernameTaken'))
      );
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = await User.create({
      username,
      displayName,
      email,
      passwordHash,
      createdAt: new Date(),
    });

    let emailWarning: string | null = null;
    try {
      const { token } = await createEmailVerificationToken(user);
      const result = await sendEmailVerificationEmail(user, token);
      if (result.skipped) {
        emailWarning = req.t('account.create.emailWarning');
      }
    } catch (error) {
      emailWarning = req.t('account.create.emailWarning');
      console.error('Failed to send signup verification email:', error);
    }

    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAt);
    const query = new URLSearchParams({ firstRun: '1' });
    if (emailWarning) {
      query.set(EMAIL_STATUS_QUERY_KEY, EMAIL_STATUS_UNAVAILABLE);
    }
    res.redirect(302, `/tool/complete-profile?${query.toString()}`);
  });

  app.get('/tool/complete-profile', async (req, res) => {
    const user = await requireSignedInUser(req, res);
    if (!user) return;

    const state = await getAccountLifecycleState(user.id);
    if (!state) {
      res.redirect(302, DEFAULT_POST_SIGNUP_REDIRECT);
      return;
    }

    if (state.agentAccessStatus === 'pending') {
      renderToolLayout(
        res,
        req.t('account.profile.title'),
        `<div class="tool-page"><div class="form-card"><p>${req.t('account.profile.pending')}</p></div></div>`
      );
      return;
    }

    if (state.agentAccessStatus === 'approved') {
      res.redirect(302, DEFAULT_POST_SIGNUP_REDIRECT);
      return;
    }

    const emailStatus =
      typeof req.query.email === 'string' && req.query.email === EMAIL_STATUS_UNAVAILABLE
        ? EMAIL_STATUS_UNAVAILABLE
        : null;
    renderToolLayout(res, req.t('account.profile.title'), renderCompleteProfileForm(req, { emailStatus }));
  });

  app.post('/tool/complete-profile', async (req, res) => {
    const user = await requireSignedInUser(req, res);
    if (!user) return;

    const action = String(req.body.action ?? 'submit');
    const emailStatus =
      typeof req.body?.email === 'string' && req.body.email === EMAIL_STATUS_UNAVAILABLE
        ? EMAIL_STATUS_UNAVAILABLE
        : null;
    if (action === 'skip') {
      res.redirect(302, appendOptionalEmailStatus(DEFAULT_POST_SIGNUP_REDIRECT, emailStatus));
      return;
    }

    const interests = String(req.body.interests ?? '').trim();
    const profileUrlInput = String(req.body.profileUrl ?? '').trim();
    const profileUrl = normalizeProfileUrl(profileUrlInput);

    if (!interests || !profileUrl) {
      renderToolLayout(
        res,
        req.t('account.profile.title'),
        renderCompleteProfileForm(req, {
          errorMessage: req.t('account.profile.errorRequired'),
          emailStatus,
          interests,
          profileUrl: profileUrlInput,
        })
      );
      return;
    }

    await upsertAgentAccessRequest(user.id, interests, profileUrl);
    res.redirect(302, appendOptionalEmailStatus(DEFAULT_POST_SIGNUP_REDIRECT, emailStatus));
  });

  app.post('/tool/resend-confirmation-email', async (req, res) => {
    const user = await requireSignedInUser(req, res);
    if (!user) return;

    const resendRateLimit = consumeRateLimit(
      'resendConfirmationEmail',
      getRateLimitKey(req, 'resend-confirmation-email')
    );
    if (!resendRateLimit.allowed) {
      const redirectTo =
        typeof req.body.redirectTo === 'string' && req.body.redirectTo.startsWith('/')
          ? req.body.redirectTo
          : DEFAULT_POST_SIGNUP_REDIRECT;
      res
        .status(429)
        .set('Retry-After', String(resendRateLimit.retryAfterSeconds))
        .redirect(302, withEmailStatus(redirectTo, EMAIL_STATUS_RATE_LIMITED));
      return;
    }

    if (!user.emailVerifiedAt) {
      try {
        const { token } = await createEmailVerificationToken(user);
        const result = await sendEmailVerificationEmail(user, token);
        if (result.skipped) {
          const redirectTo =
            typeof req.body.redirectTo === 'string' && req.body.redirectTo.startsWith('/')
              ? req.body.redirectTo
              : DEFAULT_POST_SIGNUP_REDIRECT;
          res.redirect(302, withEmailStatus(redirectTo, EMAIL_STATUS_UNAVAILABLE));
          return;
        }
      } catch (error) {
        console.error('Failed to resend verification email:', error);
        const redirectTo =
          typeof req.body.redirectTo === 'string' && req.body.redirectTo.startsWith('/')
            ? req.body.redirectTo
            : DEFAULT_POST_SIGNUP_REDIRECT;
        res.redirect(302, withEmailStatus(redirectTo, EMAIL_STATUS_UNAVAILABLE));
        return;
      }
    }

    const redirectTo =
      typeof req.body.redirectTo === 'string' && req.body.redirectTo.startsWith('/')
        ? req.body.redirectTo
        : req.originalUrl || DEFAULT_POST_SIGNUP_REDIRECT;
    res.redirect(302, redirectTo);
  });

  app.post('/tool/account/dismiss-notice', async (req, res) => {
    const user = await requireSignedInUser(req, res);
    if (!user) return;

    const noticeKey = String(req.body.noticeKey ?? '');
    if (noticeKey === AGENT_ACCESS_GRANTED_NOTICE || noticeKey === AGENT_ACCESS_REJECTED_NOTICE) {
      await dismissUserNotice(user.id, noticeKey);
    }

    const redirectTo =
      typeof req.headers.referer === 'string' && req.headers.referer.startsWith('http')
        ? new URL(req.headers.referer).pathname
        : DEFAULT_POST_SIGNUP_REDIRECT;
    res.redirect(302, redirectTo);
  });

  app.get('/tool/review-requests', async (_req, res) => {
    res.redirect(302, ACCOUNT_REVIEW_PATH);
  });

  app.get(ACCOUNT_REVIEW_PATH, async (req, res) => {
    await renderAccountReviewPage(req, res);
  });

  app.post(`${ACCOUNT_REVIEW_PATH}/approve`, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const userId = String(req.body.userId ?? '').trim();
    if (userId) {
      await approveAgentAccessRequest(userId, adminContext.session.userId);
    }
    res.redirect(302, ACCOUNT_REVIEW_PATH);
  });

  app.post(`${ACCOUNT_REVIEW_PATH}/reject`, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const userId = String(req.body.userId ?? '').trim();
    const rejectionReason = String(req.body.rejectionReason ?? '').trim();
    if (userId && rejectionReason) {
      await rejectAgentAccessRequest(userId, adminContext.session.userId, rejectionReason);
    }
    res.redirect(302, ACCOUNT_REVIEW_PATH);
  });

  app.post(`${ACCOUNT_REVIEW_PATH}/block`, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const userId = String(req.body.userId ?? '').trim();
    const blockReason = String(req.body.blockReason ?? '').trim();
    if (userId && userId !== adminContext.session.userId) {
      await blockUserAccount(
        adminContext.dalInstance,
        userId,
        adminContext.session.userId,
        blockReason || null
      );
    }
    res.redirect(302, ACCOUNT_REVIEW_PATH);
  });

  app.post(`${ACCOUNT_REVIEW_PATH}/unblock`, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const userId = String(req.body.userId ?? '').trim();
    if (userId) {
      await unblockUserAccount(userId);
    }
    res.redirect(302, ACCOUNT_REVIEW_PATH);
  });

  app.post(`${ACCOUNT_REVIEW_PATH}/bulk`, async (req, res) => {
    const adminContext = await requireSiteAdmin(req, res);
    if (!adminContext) return;

    const rawUserIds: string[] = Array.isArray(req.body.userIds)
      ? req.body.userIds.map(userId => String(userId))
      : req.body.userIds
        ? [String(req.body.userIds)]
        : [];
    const userIds = [...new Set(rawUserIds.map(userId => String(userId).trim()).filter(Boolean))];
    const bulkAction = String(req.body.bulkAction ?? '');
    const blockReason = String(req.body.blockReason ?? '').trim();
    let changed = 0;
    let skipped = 0;

    if (bulkAction === 'block') {
      const targetUserIds = userIds.filter(userId => userId !== adminContext.session.userId);
      skipped = userIds.length - targetUserIds.length;
      await Promise.all(
        targetUserIds.map(userId =>
          blockUserAccount(
            adminContext.dalInstance,
            userId,
            adminContext.session.userId,
            blockReason || null
          )
        )
      );
      changed = targetUserIds.length;
    } else if (bulkAction === 'unblock') {
      await Promise.all(userIds.map(userId => unblockUserAccount(userId)));
      changed = userIds.length;
    }

    const redirectTo =
      typeof req.body.redirectTo === 'string' && req.body.redirectTo.startsWith(ACCOUNT_REVIEW_PATH)
        ? req.body.redirectTo
        : ACCOUNT_REVIEW_PATH;
    res.redirect(302, appendAccountReviewStatus(redirectTo, { action: bulkAction, changed, skipped }));
  });
};
