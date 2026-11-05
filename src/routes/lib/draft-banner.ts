import type { TFunction } from 'i18next';
import { resolvePageAddress } from '../../lib/page-address.js';
import { encodeSlugPath } from '../../lib/slug.js';
import { escapeHtml } from '../../render.js';

export const publishDraftPath = (slug: string) => `/${encodeSlugPath(slug)}/publish-draft`;

export const renderDraftBanner = ({
  canPublish,
  slug,
  t,
}: {
  canPublish: boolean;
  slug: string;
  t: TFunction;
}) => {
  const target = resolvePageAddress(slug)?.localName ?? slug;
  const publishHtml = canPublish
    ? `<form class="draft-banner-publish" method="post" action="${escapeHtml(publishDraftPath(slug))}">
    <button type="submit">${escapeHtml(t('draft.publishButton'))}</button>
    <span class="draft-banner-help">${escapeHtml(t('draft.publishHelp', { address: `/${target}` }))}</span>
  </form>`
    : '';
  return `<aside class="draft-banner" role="note">
  <p>${escapeHtml(t('draft.banner'))}</p>
  ${publishHtml}
</aside>`;
};
