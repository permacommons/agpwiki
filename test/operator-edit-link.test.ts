import assert from 'node:assert/strict';
import test from 'node:test';

import { renderOperatorEditRelatedLink } from '../src/routes/lib/operator-edit-link.js';

const t = (key: string, options?: Record<string, unknown>) => {
  const translations: Record<string, string> = {
    'operatorEdit.link': 'Operator edit',
    'operatorEdit.signedOut': '{{loginLink}} or {{signupLink}} to edit',
    'auth.login.action': 'Log in',
    'accountRequest.title': 'Create account',
  };

  let value = translations[key] ?? key;
  if (options) {
    for (const [name, replacement] of Object.entries(options)) {
      value = value.replace(`{{${name}}}`, String(replacement));
    }
  }
  return value;
};

test('renderOperatorEditRelatedLink returns operator edit link for signed-in users', () => {
  const html = renderOperatorEditRelatedLink({
    signedIn: true,
    visible: true,
    operatorEditHref: '/barack-obama/operator-edit?lang=en',
    loginHref: '/tool/login?redirect=%2Fbarack-obama%2Foperator-edit%3Flang%3Den',
    signupHref: '/tool/create-account',
    t: t as never,
  });

  assert.equal(html, '<a href="/barack-obama/operator-edit?lang=en">Operator edit</a>');
});

test('renderOperatorEditRelatedLink returns login and signup CTA for signed-out users', () => {
  const html = renderOperatorEditRelatedLink({
    signedIn: false,
    visible: true,
    operatorEditHref: '/barack-obama/operator-edit?lang=en',
    loginHref: '/tool/login?redirect=%2Fbarack-obama%2Foperator-edit%3Flang%3Den',
    signupHref: '/tool/create-account',
    t: t as never,
  });

  assert.equal(
    html,
    '<a href="/tool/login?redirect=%2Fbarack-obama%2Foperator-edit%3Flang%3Den">Log in</a> or <a href="/tool/create-account">Create account</a> to edit'
  );
});
