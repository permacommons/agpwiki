import type { TFunction } from 'i18next';

import { escapeHtml } from '../../render.js';

export const HOW_TO_EDIT_PATH = '/tool/how-to-edit';

export const howToEditPath = (slug: string) =>
  `${HOW_TO_EDIT_PATH}?page=${encodeURIComponent(slug)}`;

type OperatorEditLinkParams = {
  signedIn: boolean;
  visible: boolean;
  operatorEditHref: string;
  loginHref: string;
  signupHref: string;
  t: TFunction;
};

export const renderOperatorEditRelatedLink = ({
  signedIn,
  visible,
  operatorEditHref,
  loginHref,
  signupHref,
  t,
}: OperatorEditLinkParams): string => {
  if (!visible) {
    return '';
  }

  if (signedIn) {
    return `<a href="${escapeHtml(operatorEditHref)}">${escapeHtml(t('operatorEdit.link'))}</a>`;
  }

  return t('operatorEdit.signedOut', {
    loginLink: `<a href="${escapeHtml(loginHref)}">${escapeHtml(t('auth.login.action'))}</a>`,
    signupLink: `<a href="${escapeHtml(signupHref)}">${escapeHtml(t('account.create.title'))}</a>`,
  });
};
