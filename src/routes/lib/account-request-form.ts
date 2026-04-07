import type { TFunction } from 'i18next';

import { escapeHtml } from '../../render.js';

export const renderAccountRequestProfileField = (t: TFunction, value = '') => `<label class="form-field">
  <span>${escapeHtml(t('accountRequest.form.profileUrl'))}</span>
  <input
    type="url"
    name="profileUrl"
    autocomplete="url"
    value="${escapeHtml(value)}"
  />
  <div class="form-hint">${escapeHtml(t('accountRequest.form.profileUrlHint'))}</div>
</label>`;
