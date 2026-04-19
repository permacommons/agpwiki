import type { Express, Request, Response } from 'express';
import type { TFunction } from 'i18next';

import { hashPassword } from '../auth/password.js';
import { createSession, resolveSessionUser, setSessionCookie } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import { createAltchaChallenge, isAltchaEnabled, verifyAltchaSolution } from '../lib/altcha.js';
import { isValidUsername, normalizeUsername, trimDisplayName } from '../lib/username.js';
import User from '../models/user.js';
import { escapeHtml, formatDateUTC, renderLayout } from '../render.js';
import {
  AGENT_ACCESS_GRANTED_NOTICE,
  AGENT_ACCESS_REJECTED_NOTICE,
  approveAgentAccessRequest,
  blockUserAccount,
  dismissUserNotice,
  getAccountLifecycleState,
  normalizeProfileUrl,
  rejectAgentAccessRequest,
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
const DEFAULT_POST_SIGNUP_REDIRECT = '/meta/welcome';
const EMAIL_STATUS_QUERY_KEY = 'email';
const EMAIL_STATUS_UNAVAILABLE = 'unavailable';
const EMAIL_STATUS_RATE_LIMITED = 'rate-limited';

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
    topHtml: prependAccountBanner(res),
    signedIn,
    currentUserName: res.locals.currentUserName,
    currentPath: res.locals.currentPath,
    locale: res.locals.locale,
    languageOptions: res.locals.languageOptions,
  });

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
    res.status(403).type('html').send(
      renderToolLayout(
        req.t,
        res,
        req.t('page.forbidden'),
        `<div class="tool-page"><p>${req.t('page.accessDenied')}</p></div>`,
        true
      )
    );
    return null;
  }

  return { session, dalInstance };
};

const renderAccountReviewPage = async (req: Request, res: Response) => {
  const adminContext = await requireSiteAdmin(req, res);
  if (!adminContext) return;

  const { dalInstance } = adminContext;
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
     ORDER BY u.created_at DESC`
  );

  const rows = result.rows.length === 0
    ? `<tr><td colspan="6">${req.t('account.review.empty')}</td></tr>`
    : result.rows.map(row => {
        const userId = String(row.id);
        const agentStatus = typeof row.agent_status === 'string' ? row.agent_status : 'none';
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
          ? `<span>${req.t('account.review.blocked')}</span>`
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

        return `<tr>
  <td>
    <div>${escapeHtml(String(row.username ?? ''))}</div>
    <div class="form-hint">${escapeHtml(String(row.display_name ?? ''))}</div>
  </td>
  <td>${escapeHtml(String(row.email ?? ''))}</td>
  <td>${escapeHtml(formatDateUTC(row.created_at as Date | string | null))}</td>
  <td>${row.email_verified_at ? req.t('account.review.verified') : req.t('account.review.unverified')}</td>
  <td>
    <div>${escapeHtml(req.t(`account.review.status.${agentStatus}`))}</div>
    <div>${escapeHtml(String(row.interests ?? ''))}</div>
    ${profileHtml}
    ${rejectionReason}
  </td>
  <td><div class="account-review-actions">${actions}</div></td>
</tr>`;
      }).join('');

  const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-help">${req.t('account.review.description')}</p>
    <table class="token-table">
      <thead>
        <tr>
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
</div>`;

  res
    .type('html')
    .send(renderToolLayout(req.t, res, req.t('account.review.title'), bodyHtml, true));
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

    res
      .type('html')
      .send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.create.title'),
          renderCreateAccountForm(req),
          false
        )
      );
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
      res
        .status(429)
        .set('Retry-After', String(signupRateLimit.retryAfterSeconds))
        .type('html')
        .send(
          renderToolLayout(
            req.t,
            res,
            req.t('account.create.title'),
            renderCreateAccountForm(
              req,
              { displayName, email },
              req.t('account.create.errorRateLimited')
            ),
            false
          )
        );
      return;
    }

    const altchaValid = await verifyAltchaSolution(altchaPayload);
    if (!altchaValid) {
      res.type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.create.title'),
          renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorCaptcha')),
          false
        )
      );
      return;
    }

    if (!displayName || !email || !password || !username) {
      res.type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.create.title'),
          renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorRequired')),
          false
        )
      );
      return;
    }

    if (!isValidUsername(displayName)) {
      res.type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.create.title'),
          renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorUsernameInvalid')),
          false
        )
      );
      return;
    }

    const [existingEmail, existingUsername] = await Promise.all([
      User.filterWhere({ email }).first(),
      User.filterWhere({ username }).first(),
    ]);

    if (existingEmail) {
      res.type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.create.title'),
          renderCreateAccountForm(
            req,
            { displayName, email },
            req.t('account.create.errorEmailUnavailable')
          ),
          false
        )
      );
      return;
    }

    if (existingUsername) {
      res.type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.create.title'),
          renderCreateAccountForm(req, { displayName, email }, req.t('account.create.errorUsernameTaken')),
          false
        )
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
      res
        .type('html')
        .send(
          renderToolLayout(
            req.t,
            res,
            req.t('account.profile.title'),
            `<div class="tool-page"><div class="form-card"><p>${req.t('account.profile.pending')}</p></div></div>`,
            true
          )
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
    res
      .type('html')
      .send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.profile.title'),
          renderCompleteProfileForm(req, { emailStatus }),
          true
        )
      );
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
      res.type('html').send(
        renderToolLayout(
          req.t,
          res,
          req.t('account.profile.title'),
          renderCompleteProfileForm(req, {
            errorMessage: req.t('account.profile.errorRequired'),
            emailStatus,
            interests,
            profileUrl: profileUrlInput,
          }),
          true
        )
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
};
