import type { Express, Request, Response } from 'express';

import { hashPassword, verifyPassword } from '../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  getSessionToken,
  resolveSessionUser,
  revokeSession,
  setSessionCookie,
} from '../auth/session.js';
import { generateApiToken, hashToken } from '../auth/tokens.js';
import { initializePostgreSQL } from '../db.js';
import ApiToken from '../models/api-token.js';
import SignupInvite from '../models/signup-invite.js';
import User from '../models/user.js';
import { escapeHtml, formatDateUTC, renderLayout } from '../render.js';

const renderAuthLayout = (title: string, bodyHtml: string, signedIn = false) =>
  renderLayout({
    title,
    labelHtml: '<div class="page-label">TOOL — BUILT-IN SOFTWARE FEATURE</div>',
    bodyHtml,
    signedIn,
  });

const renderError = (message: string) =>
  `<div class="form-error">${escapeHtml(message)}</div>`;

const requireAuthUser = async (req: Request, res: Response) => {
  const session = await resolveSessionUser(req);
  if (!session) {
    res.redirect(302, '/tool/auth/login');
    return null;
  }
  return session.userId;
};

const isValidEmail = (value: string) => Boolean(value?.includes('@') && value.includes('.'));

export const registerAuthRoutes = (app: Express) => {
  app.get('/tool/auth/login', async (req, res) => {
    const session = await resolveSessionUser(req);
    if (session) {
      res.redirect(302, '/tool/account/tokens');
      return;
    }

    const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    <label class="form-field">
      <span>Email</span>
      <input type="email" name="email" autocomplete="email" required />
    </label>
    <label class="form-field">
      <span>Password</span>
      <input type="password" name="password" autocomplete="current-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">Log in</button>
    </div>
    <p class="form-help">Need an invite? Use <code>/tool/auth/signup</code>.</p>
  </form>
</div>`;

    res.type('html').send(renderAuthLayout('Log in', bodyHtml, false));
  });

  app.post('/tool/auth/login', async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    const user = email ? await User.filterWhere({ email }).first() : null;
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;

    if (!user || !valid) {
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${renderError('Invalid email or password.')}
    <label class="form-field">
      <span>Email</span>
      <input type="email" name="email" autocomplete="email" required value="${escapeHtml(
        email
      )}" />
    </label>
    <label class="form-field">
      <span>Password</span>
      <input type="password" name="password" autocomplete="current-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">Log in</button>
    </div>
  </form>
</div>`;
      res.type('html').send(renderAuthLayout('Log in', bodyHtml, false));
      return;
    }

    const session = await createSession(user.id);
    setSessionCookie(res, session.token, session.expiresAt);
    res.redirect(302, '/tool/account/tokens');
  });

  app.post('/tool/auth/logout', async (req, res) => {
    const token = getSessionToken(req);
    if (token) {
      await revokeSession(token);
    }
    clearSessionCookie(res);
    res.redirect(302, '/tool/auth/login');
  });

  app.get('/tool/auth/signup', async (req, res) => {
    const codeParam = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    if (codeParam) {
      await initializePostgreSQL();
      const inviteHash = hashToken(codeParam);
      const invite = await SignupInvite.findActiveByHash(inviteHash);
      if (!invite) {
        const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${renderError('Invite code is invalid or expired.')}
    <label class="form-field">
      <span>Invite code</span>
      <input type="text" name="code" autocomplete="one-time-code" required />
    </label>
    <div class="form-actions">
      <button type="submit">Continue</button>
    </div>
  </form>
</div>`;
        res.type('html').send(renderAuthLayout('Sign up', bodyHtml, false));
        return;
      }

      const lockEmail = Boolean(invite.email);
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    <input type="hidden" name="code" value="${escapeHtml(codeParam)}" />
    <label class="form-field">
      <span>Display name</span>
      <input type="text" name="displayName" required />
    </label>
    <label class="form-field">
      <span>Email</span>
      <input type="email" name="email" autocomplete="email" required value="${escapeHtml(
        invite.email ?? ''
      )}" ${lockEmail ? 'readonly' : ''} />
    </label>
    <label class="form-field">
      <span>Password</span>
      <input type="password" name="password" autocomplete="new-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">Create account</button>
    </div>
  </form>
</div>`;
      res.type('html').send(renderAuthLayout('Create account', bodyHtml, false));
      return;
    }

    const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    <label class="form-field">
      <span>Invite code</span>
      <input type="text" name="code" autocomplete="one-time-code" required />
    </label>
    <div class="form-actions">
      <button type="submit">Continue</button>
    </div>
  </form>
</div>`;

    res.type('html').send(renderAuthLayout('Sign up', bodyHtml, false));
  });

  app.post('/tool/auth/signup', async (req, res) => {
    const code = String(req.body.code ?? '').trim();
    const displayName = String(req.body.displayName ?? '').trim();
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    if (!code) {
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${renderError('Invite code is required.')}
    <label class="form-field">
      <span>Invite code</span>
      <input type="text" name="code" required />
    </label>
    <div class="form-actions">
      <button type="submit">Continue</button>
    </div>
  </form>
</div>`;
      res.type('html').send(renderAuthLayout('Sign up', bodyHtml, false));
      return;
    }

    const dalInstance = await initializePostgreSQL();
    const inviteHash = hashToken(code);
    const invite = await SignupInvite.findActiveByHash(inviteHash);
    if (!invite) {
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${renderError('Invite code is invalid or expired.')}
    <label class="form-field">
      <span>Invite code</span>
      <input type="text" name="code" required />
    </label>
    <div class="form-actions">
      <button type="submit">Continue</button>
    </div>
  </form>
</div>`;
      res.type('html').send(renderAuthLayout('Sign up', bodyHtml, false));
      return;
    }

    if (!displayName || !email || !password) {
      const lockEmail = Boolean(invite.email);
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    <input type="hidden" name="code" value="${escapeHtml(code)}" />
    <label class="form-field">
      <span>Display name</span>
      <input type="text" name="displayName" required />
    </label>
    <label class="form-field">
      <span>Email</span>
      <input type="email" name="email" autocomplete="email" required value="${escapeHtml(
        invite.email ?? ''
      )}" ${lockEmail ? 'readonly' : ''} />
    </label>
    <label class="form-field">
      <span>Password</span>
      <input type="password" name="password" autocomplete="new-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">Create account</button>
    </div>
  </form>
</div>`;
      res.type('html').send(renderAuthLayout('Create account', bodyHtml, false));
      return;
    }

    if (!isValidEmail(email)) {
      res
        .type('html')
        .send(renderAuthLayout('Create account', renderError('Email is invalid.'), false));
      return;
    }

    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
      res
        .type('html')
        .send(
          renderAuthLayout(
            'Create account',
            renderError('Invite code is locked to a different email.'),
            false
          )
        );
      return;
    }

    try {
      const passwordHash = await hashPassword(password);
      const user = await User.create({
        displayName,
        email,
        passwordHash,
        createdAt: new Date(),
      });

      invite.usedAt = new Date();
      invite.usedBy = user.id;
      await invite.save();

      if (invite.role) {
        await dalInstance.query(
          'INSERT INTO user_roles (user_id, role, created_at) VALUES ($1, $2, NOW())',
          [user.id, invite.role]
        );
      }

      const session = await createSession(user.id);
      setSessionCookie(res, session.token, session.expiresAt);
      res.redirect(302, '/tool/account/tokens');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const bodyHtml = `<div class="tool-page">
  <form method="post" class="form-card">
    ${renderError(message)}
    <input type="hidden" name="code" value="${escapeHtml(code)}" />
    <label class="form-field">
      <span>Display name</span>
      <input type="text" name="displayName" required value="${escapeHtml(displayName)}" />
    </label>
    <label class="form-field">
      <span>Email</span>
      <input type="email" name="email" required value="${escapeHtml(email)}" />
    </label>
    <label class="form-field">
      <span>Password</span>
      <input type="password" name="password" autocomplete="new-password" required />
    </label>
    <div class="form-actions">
      <button type="submit">Create account</button>
    </div>
  </form>
</div>`;
      res.type('html').send(renderAuthLayout('Create account', bodyHtml, false));
    }
  });

  app.get('/tool/account/tokens', async (req, res) => {
    const userId = await requireAuthUser(req, res);
    if (!userId) return;

    const showRevoked = typeof req.query.show === 'string' && req.query.show === 'revoked';
    const filter = showRevoked ? { userId } : { userId, revokedAt: null };
    const tokens = await ApiToken.filterWhere(filter).orderBy('createdAt', 'DESC').run();

    const rows = tokens
      .map(token => {
        const label = token.label ? escapeHtml(token.label) : 'Untitled';
        const status = token.revokedAt ? 'Revoked' : 'Active';
        const lastUsed = token.lastUsedAt ? formatDateUTC(token.lastUsedAt) : '';
        const last4 = token.tokenLast4 ? `…${token.tokenLast4}` : token.tokenPrefix;
        return `<tr>
  <td>${label}</td>
  <td>${escapeHtml(last4)}</td>
  <td>${escapeHtml(status)}</td>
  <td>${escapeHtml(lastUsed)}</td>
  <td>
    <form method="post" action="/tool/account/tokens/revoke">
      <input type="hidden" name="tokenId" value="${escapeHtml(token.id)}" />
      <button type="submit">Revoke</button>
    </form>
    <form method="post" action="/tool/account/tokens/reset">
      <input type="hidden" name="tokenId" value="${escapeHtml(token.id)}" />
      <button type="submit">Regenerate</button>
    </form>
  </td>
</tr>`;
      })
      .join('');

    const toggleLink = showRevoked
      ? '<a href="/tool/account/tokens">Hide revoked</a>'
      : '<a href="/tool/account/tokens?show=revoked">Show revoked</a>';
    const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    <p class="form-help">Create and manage API tokens for MCP access. Tokens are shown only once.</p>
    <form method="post" action="/tool/account/tokens/create" class="form-inline">
      <label>
        <span>Label</span>
        <input type="text" name="label" />
      </label>
      <button type="submit">Create token</button>
    </form>
    <div class="form-help">${toggleLink}</div>
  </div>
  <div class="form-card">
    <h2>Active tokens</h2>
    <table class="token-table">
      <thead>
        <tr>
          <th>Label</th>
          <th>Token</th>
          <th>Status</th>
          <th>Last used</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="5">No tokens yet.</td></tr>'}
      </tbody>
    </table>
  </div>
  <form method="post" action="/tool/auth/logout" class="form-card">
    <button type="submit">Log out</button>
  </form>
</div>`;

    res.type('html').send(renderAuthLayout('API tokens', bodyHtml, true));
  });

  app.post('/tool/account/tokens/create', async (req, res) => {
    const userId = await requireAuthUser(req, res);
    if (!userId) return;

    const labelInput = String(req.body.label ?? '').trim();
    const label = labelInput ? labelInput : null;
    if (label) {
      const existing = await ApiToken.filterWhere({ userId, label, revokedAt: null }).first();
      if (existing) {
        const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    ${renderError('An active token already uses that label.')}
    <div class="form-actions">
      <a href="/tool/account/tokens">Back to tokens</a>
    </div>
  </div>
</div>`;
        res.type('html').send(renderAuthLayout('New token', bodyHtml, true));
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
    <p class="form-help">Copy this token now. You will not be able to see it again.</p>
    <div class="token-display">${escapeHtml(token)}</div>
    <div class="form-actions">
      <a href="/tool/account/tokens">Back to tokens</a>
    </div>
  </div>
</div>`;

    res.type('html').send(renderAuthLayout('New token', bodyHtml, true));
  });

  app.post('/tool/account/tokens/revoke', async (req, res) => {
    const userId = await requireAuthUser(req, res);
    if (!userId) return;
    const tokenId = String(req.body.tokenId ?? '').trim();
    if (!tokenId) {
      res.redirect(302, '/tool/account/tokens');
      return;
    }

    const token = await ApiToken.filterWhere({ id: tokenId, userId }).first();
    if (token && !token.revokedAt) {
      token.revokedAt = new Date();
      await token.save();
    }

    res.redirect(302, '/tool/account/tokens');
  });

  app.post('/tool/account/tokens/reset', async (req, res) => {
    const userId = await requireAuthUser(req, res);
    if (!userId) return;
    const tokenId = String(req.body.tokenId ?? '').trim();
    if (!tokenId) {
      res.redirect(302, '/tool/account/tokens');
      return;
    }

    const existing = await ApiToken.filterWhere({ id: tokenId, userId }).first();
    if (!existing) {
      const bodyHtml = `<div class="tool-page">
  <div class="form-card">
    ${renderError('Token not found for reset.')}
    <div class="form-actions">
      <a href="/tool/account/tokens">Back to tokens</a>
    </div>
  </div>
</div>`;
      res.type('html').send(renderAuthLayout('Regenerate token', bodyHtml, true));
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
    ${renderError('Another active token already uses this label.')}
    <div class="form-actions">
      <a href="/tool/account/tokens">Back to tokens</a>
    </div>
  </div>
</div>`;
        res.type('html').send(renderAuthLayout('Regenerate token', bodyHtml, true));
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
    <p class="form-help">Copy this token now. You will not be able to see it again.</p>
    <div class="token-display">${escapeHtml(token)}</div>
    <div class="form-actions">
      <a href="/tool/account/tokens">Back to tokens</a>
    </div>
  </div>
</div>`;

    res.type('html').send(renderAuthLayout('Regenerate token', bodyHtml, true));
  });
};
