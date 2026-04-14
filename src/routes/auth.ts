import type { Express, Request, Response } from 'express';
import type { TFunction } from 'i18next';

import { verifyPassword } from '../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  getSessionToken,
  resolveSessionUser,
  revokeSession,
  setSessionCookie,
} from '../auth/session.js';
import { generateApiToken, hashToken } from '../auth/tokens.js';
import { normalizeUsername } from '../lib/username.js';
import ApiToken from '../models/api-token.js';
import User from '../models/user.js';
import { escapeHtml, formatDateUTC, renderLayout } from '../render.js';
import { getAccountLifecycleState, userCanUseAgentFeatures } from '../services/account-lifecycle.js';
import { verifyEmailConfirmationToken } from '../services/email-verification.js';
import { consumeRateLimit, getRateLimitKey } from '../services/request-rate-limit.js';
import { prependAccountBanner, renderAccountBanner } from './lib/account-banner.js';

const renderAuthLayout = (
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

const TOOL_LOGIN_PATH = '/tool/login';
const TOOL_SIGNUP_PATH = '/tool/signup';
const TOOL_LOGOUT_PATH = '/tool/logout';
const TOOL_TOKENS_PATH = '/tool/tokens';
const DEFAULT_LOGIN_REDIRECT_PATH = '/meta/welcome';
const EMAIL_CONFIRMED_QUERY_KEY = 'emailConfirmed';

const getSafeRedirect = (value: string | null) => {
  if (!value) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.includes('\\')) return null;
  return value;
};

const requireAuthUser = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(302, TOOL_LOGIN_PATH);
    return null;
  }
  return session.userId;
};

const requireAgentEnabledUser = async (req: Request, res: Response) => {
  const userId = await requireAuthUser(req, res);
  if (!userId) return null;

  const accountState = await getAccountLifecycleState(userId);
  if (!accountState || !userCanUseAgentFeatures(accountState)) {
    res.status(403).type('html').send(
      renderAuthLayout(
        req.t,
        res,
        req.t('auth.tokens.title'),
        `<div class="tool-page"><div class="form-card"><p>${req.t('auth.tokens.errorUnavailable')}</p></div></div>`,
        true
      )
    );
    return null;
  }

  return userId;
};

export const registerAuthRoutes = (app: Express) => {
  app.get(TOOL_LOGIN_PATH, async (req, res) => {
    const redirectTo = getSafeRedirect(
      typeof req.query.redirect === 'string' ? req.query.redirect : null
    );
    const emailConfirmed = req.query.emailConfirmed === '1';
    const session = await resolveSessionUser(req);
    if (session) {
      res.redirect(302, redirectTo ?? DEFAULT_LOGIN_REDIRECT_PATH);
      return;
    }

    const redirectField = redirectTo
      ? `<input type="hidden" name="redirect" value="${escapeHtml(redirectTo)}" />`
      : '';

    const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${emailConfirmed ? `<div class="form-help">${escapeHtml(req.t('auth.login.emailConfirmed'))}</div>` : ''}
    ${redirectField}
    <label class="form-field">
      <span>${req.t('auth.form.identifier')}</span>
      <input type="text" name="identifier" autocomplete="username" required />
    </label>
    <label class="form-field">
      <span>${req.t('auth.form.password')}</span>
      <input type="password" name="password" autocomplete="current-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">${req.t('auth.login.action')}</button>
    </div>
    <p class="form-help">${req.t('auth.login.createAccount')}</p>
  </form>
</div>`;

    res
      .type('html')
      .send(
        renderAuthLayout(req.t, res, req.t('auth.login.title'), bodyHtml, false)
      );
  });

  const handleLogin = async (req: Request, res: Response) => {
    const identifier = String(req.body.identifier ?? '').trim();
    const password = String(req.body.password ?? '');
    const redirectTo = getSafeRedirect(String(req.body.redirect ?? '').trim()) ?? null;
    const loginRateLimit = consumeRateLimit('login', getRateLimitKey(req, 'login'));

    if (!loginRateLimit.allowed) {
      const redirectField = redirectTo
        ? `<input type="hidden" name="redirect" value="${escapeHtml(redirectTo)}" />`
        : '';
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${renderError(req.t('auth.login.errorRateLimited'))}
    ${redirectField}
    <label class="form-field">
      <span>${req.t('auth.form.identifier')}</span>
      <input type="text" name="identifier" autocomplete="username" required value="${escapeHtml(
        identifier
      )}" />
    </label>
    <label class="form-field">
      <span>${req.t('auth.form.password')}</span>
      <input type="password" name="password" autocomplete="current-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">${req.t('auth.login.action')}</button>
    </div>
  </form>
</div>`;
      res
        .status(429)
        .set('Retry-After', String(loginRateLimit.retryAfterSeconds))
        .type('html')
        .send(
          renderAuthLayout(req.t, res, req.t('auth.login.title'), bodyHtml, false)
        );
      return;
    }

    const user = identifier.includes('@')
      ? await User.filterWhere({ email: identifier.toLowerCase() }).first()
      : await (async () => {
          const username = normalizeUsername(identifier);
          return username ? User.filterWhere({ username }).first() : null;
        })();
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;

    if (!user || !valid || user.blockedAt) {
      const redirectField = redirectTo
        ? `<input type="hidden" name="redirect" value="${escapeHtml(redirectTo)}" />`
        : '';
      const errorKey = user?.blockedAt ? 'auth.login.errorBlocked' : 'auth.login.errorInvalid';
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${renderError(req.t(errorKey))}
    ${redirectField}
    <label class="form-field">
      <span>${req.t('auth.form.identifier')}</span>
      <input type="text" name="identifier" autocomplete="username" required value="${escapeHtml(
        identifier
      )}" />
    </label>
    <label class="form-field">
      <span>${req.t('auth.form.password')}</span>
      <input type="password" name="password" autocomplete="current-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">${req.t('auth.login.action')}</button>
    </div>
  </form>
</div>`;
      res
        .type('html')
        .send(
          renderAuthLayout(req.t, res, req.t('auth.login.title'), bodyHtml, false)
        );
      return;
    }

    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAt);
    res.redirect(302, redirectTo ?? DEFAULT_LOGIN_REDIRECT_PATH);
  };

  app.post(TOOL_LOGIN_PATH, handleLogin);

  const handleLogout = async (req: Request, res: Response) => {
    const token = getSessionToken(req);
    if (token) {
      await revokeSession(token);
    }
    clearSessionCookie(res);
    res.redirect(302, TOOL_LOGIN_PATH);
  };

  app.post(TOOL_LOGOUT_PATH, handleLogout);

  app.get(TOOL_SIGNUP_PATH, async (_req, res) => {
    res.redirect(302, '/tool/create-account');
  });

  app.post(TOOL_SIGNUP_PATH, async (_req, res) => {
    res.redirect(307, '/tool/create-account');
  });

  app.get('/tool/confirm-email', async (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const user = token ? await verifyEmailConfirmationToken(token) : null;
    if (user) {
      const session = await resolveSessionUser(req);
      if (!session) {
        res.redirect(302, `${TOOL_LOGIN_PATH}?${EMAIL_CONFIRMED_QUERY_KEY}=1`);
        return;
      }

      if (session.userId === user.id) {
        res.locals.accountState = await getAccountLifecycleState(user.id);
        res.locals.accountBannerHtml = renderAccountBanner(req, res);
      }
    }
    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p>${user ? req.t('account.confirm.success') : req.t('account.confirm.error')}</p>
    <p><a href="${escapeHtml(DEFAULT_LOGIN_REDIRECT_PATH)}">${req.t('account.confirm.continue')}</a></p>
  </div>
</div>`;
    res
      .type('html')
      .send(renderAuthLayout(req.t, res, req.t('account.confirm.title'), bodyHtml, Boolean(user)));
  });

  app.get(TOOL_TOKENS_PATH, async (req, res) => {
    const userId = await requireAgentEnabledUser(req, res);
    if (!userId) return;

    const showRevoked = typeof req.query.show === 'string' && req.query.show === 'revoked';
    const filter = showRevoked ? { userId } : { userId, revokedAt: null };
    const tokens = await ApiToken.filterWhere(filter).orderBy('createdAt', 'DESC').run();

    const rows = tokens
      .map(token => {
        const label = token.label
          ? escapeHtml(token.label)
          : req.t('auth.tokens.untitled');
        const status = token.revokedAt
          ? req.t('auth.tokens.revoked')
          : req.t('auth.tokens.active');
        const lastUsed = token.lastUsedAt ? formatDateUTC(token.lastUsedAt) : '';
        const last4 = token.tokenLast4 ? `…${token.tokenLast4}` : token.tokenPrefix;
        return `<tr>
  <td>${label}</td>
  <td>${escapeHtml(last4)}</td>
  <td>${escapeHtml(status)}</td>
  <td>${escapeHtml(lastUsed)}</td>
  <td>
    <form method="post" action="${TOOL_TOKENS_PATH}/revoke">
      <input type="hidden" name="tokenId" value="${escapeHtml(token.id)}" />
      <button type="submit">${req.t('auth.tokens.revoke')}</button>
    </form>
    <form method="post" action="${TOOL_TOKENS_PATH}/reset">
      <input type="hidden" name="tokenId" value="${escapeHtml(token.id)}" />
      <button type="submit">${req.t('auth.tokens.regenerate')}</button>
    </form>
  </td>
</tr>`;
      })
      .join('');

    const toggleLink = showRevoked
      ? `<a href="${TOOL_TOKENS_PATH}">${req.t('auth.tokens.hideRevoked')}</a>`
      : `<a href="${TOOL_TOKENS_PATH}?show=revoked">${req.t(
          'auth.tokens.showRevoked'
        )}</a>`;
    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-help">${req.t('auth.tokens.description')}</p>
    <form method="post" action="${TOOL_TOKENS_PATH}/create" class="form-inline">
      <label>
        <span>${req.t('auth.tokens.label')}</span>
        <input type="text" name="label" />
      </label>
      <button type="submit">${req.t('auth.tokens.create')}</button>
    </form>
    <div class="form-help">${toggleLink}</div>
  </div>
  <div class="form-card">
    <h2>${req.t('auth.tokens.activeTokens')}</h2>
    <table class="token-table">
      <thead>
        <tr>
          <th>${req.t('auth.tokens.headers.label')}</th>
          <th>${req.t('auth.tokens.headers.token')}</th>
          <th>${req.t('auth.tokens.headers.status')}</th>
          <th>${req.t('auth.tokens.headers.lastUsed')}</th>
          <th>${req.t('auth.tokens.headers.actions')}</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="5">${req.t('auth.tokens.empty')}</td></tr>`}
      </tbody>
    </table>
  </div>
  <form method="post" action="${TOOL_LOGOUT_PATH}" class="form-card">
    <button type="submit">${req.t('auth.tokens.logout')}</button>
  </form>
</div>`;

    res
      .type('html')
      .send(
        renderAuthLayout(
          req.t,
          res,
          req.t('auth.tokens.title'),
          bodyHtml,
          true
        )
      );
  });

  const handleCreateToken = async (req: Request, res: Response) => {
    const userId = await requireAgentEnabledUser(req, res);
    if (!userId) return;

    const labelInput = String(req.body.label ?? '').trim();
    const label = labelInput ? labelInput : null;
    if (label) {
      const existing = await ApiToken.filterWhere({ userId, label, revokedAt: null }).first();
      if (existing) {
        const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    ${renderError(req.t('auth.tokens.errorLabelActive'))}
    <div class="form-actions">
      <a href="${TOOL_TOKENS_PATH}">${req.t('auth.tokens.back')}</a>
    </div>
  </div>
</div>`;
        res
          .type('html')
          .send(
            renderAuthLayout(
              req.t,
              res,
              req.t('auth.tokens.newToken'),
              bodyHtml,
              true
            )
          );
        return;
      }
    }
    const token = generateApiToken();
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 8);
    const tokenLast4 = token.slice(-4);

    await ApiToken.create({
      userId,
      tokenHash,
      tokenPrefix,
      tokenLast4,
      label,
      createdAt: new Date(),
    });

    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-help">${req.t('auth.tokens.copyHelp')}</p>
    <div class="token-display">${escapeHtml(token)}</div>
    <div class="form-actions">
      <a href="${TOOL_TOKENS_PATH}">${req.t('auth.tokens.back')}</a>
    </div>
  </div>
</div>`;

    res
      .type('html')
      .send(
        renderAuthLayout(
          req.t,
          res,
          req.t('auth.tokens.newToken'),
          bodyHtml,
          true
        )
      );
  };

  app.post(`${TOOL_TOKENS_PATH}/create`, handleCreateToken);

  const handleRevokeToken = async (req: Request, res: Response) => {
    const userId = await requireAgentEnabledUser(req, res);
    if (!userId) return;
    const tokenId = String(req.body.tokenId ?? '').trim();
    if (!tokenId) {
      res.redirect(302, TOOL_TOKENS_PATH);
      return;
    }

    const token = await ApiToken.filterWhere({ id: tokenId, userId }).first();
    if (token && !token.revokedAt) {
      token.revokedAt = new Date();
      await token.save();
    }

    res.redirect(302, TOOL_TOKENS_PATH);
  };

  app.post(`${TOOL_TOKENS_PATH}/revoke`, handleRevokeToken);

  const handleResetToken = async (req: Request, res: Response) => {
    const userId = await requireAgentEnabledUser(req, res);
    if (!userId) return;
    const tokenId = String(req.body.tokenId ?? '').trim();
    if (!tokenId) {
      res.redirect(302, TOOL_TOKENS_PATH);
      return;
    }

    const existing = await ApiToken.filterWhere({ id: tokenId, userId }).first();
    if (!existing) {
      const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    ${renderError(req.t('auth.tokens.errorNotFound'))}
    <div class="form-actions">
      <a href="${TOOL_TOKENS_PATH}">${req.t('auth.tokens.back')}</a>
    </div>
  </div>
</div>`;
      res
        .type('html')
        .send(
          renderAuthLayout(
            req.t,
            res,
            req.t('auth.tokens.regenerateTitle'),
            bodyHtml,
            true
          )
        );
      return;
    }

    const label = existing.label ?? null;
    if (label) {
      const conflict = await ApiToken.filterWhere({
        userId,
        label,
        revokedAt: null,
      }).first();
      if (conflict && conflict.id !== existing.id) {
        const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    ${renderError(req.t('auth.tokens.errorLabelConflict'))}
    <div class="form-actions">
      <a href="${TOOL_TOKENS_PATH}">${req.t('auth.tokens.back')}</a>
    </div>
  </div>
</div>`;
        res
          .type('html')
          .send(
            renderAuthLayout(
              req.t,
              res,
              req.t('auth.tokens.regenerateTitle'),
              bodyHtml,
              true
            )
          );
        return;
      }
    }
    if (!existing.revokedAt) {
      existing.revokedAt = new Date();
      await existing.save();
    }

    const token = generateApiToken();
    const tokenHash = hashToken(token);
    const tokenPrefix = token.slice(0, 8);
    const tokenLast4 = token.slice(-4);

    await ApiToken.create({
      userId,
      tokenHash,
      tokenPrefix,
      tokenLast4,
      label,
      createdAt: new Date(),
    });

    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-help">${req.t('auth.tokens.copyHelp')}</p>
    <div class="token-display">${escapeHtml(token)}</div>
    <div class="form-actions">
      <a href="${TOOL_TOKENS_PATH}">${req.t('auth.tokens.back')}</a>
    </div>
  </div>
</div>`;

    res
      .type('html')
      .send(
        renderAuthLayout(
          req.t,
          res,
          req.t('auth.tokens.regenerateTitle'),
          bodyHtml,
          true
        )
      );
  };

  app.post(`${TOOL_TOKENS_PATH}/reset`, handleResetToken);
};
