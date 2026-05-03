import type { Express } from 'express';
import dal from 'rev-dal';
import { initializePostgreSQL } from '../db.js';
import { McpToolError, NotFoundError } from '../lib/errors.js';
import {
  formatMediaFigureHtml,
  formatMediaJson,
  formatMediaLabel,
  formatMediaPageTitle,
  MEDIA_MAX_DISPLAY_WIDTH,
  type MediaData,
  type MediaType,
  resolveWikimediaStepForWidth,
} from '../lib/media.js';
import {
  isValidDisplayWidth,
  MEDIA_SLUG_REGEX,
  readStandardDisplayWidths,
} from '../lib/media-validation.js';
import { resolveSafeText } from '../lib/safe-text.js';
import { escapeHtml, formatDateUTC, prepareTitle } from '../render.js';
import {
  diffMediaRevisions,
  listMediaRevisions,
  readMediaRevision,
} from '../services/media-service.js';
import { getOrFetchThumbnail } from '../services/media-thumbnail-service.js';
import { prependAccountBanner } from './lib/account-banner.js';
import {
  extractQueryParams,
  getAvailableLanguages,
  normalizeOverrideLang,
  renderContentLanguageRow,
  resolveContentLanguage,
} from './lib/content-language.js';
import { getDiffLabels, renderEntityDiff } from './lib/diff.js';
import { fetchUserMap, renderRevisionHistory } from './lib/history.js';

const { mlString } = dal;

const resolveSummary = (value: Record<string, string> | null, lang: string) =>
  resolveSafeText(mlString.resolve, lang, value, '');

// Display size used to render the figure on the standalone media
// metadata page. Must be a member of recommendedDisplayWidths so the
// route handler accepts it.
const METADATA_PAGE_SIZE = 800;

export const registerMediaRoutes = (app: Express) => {
  // Lazy-fetch thumbnail server. URL pattern:
  //   /media-files/<slug>/<width>
  // <slug> may contain `/` (multi-segment).
  app.get(/^\/media-files\/(.+)\/(\d+)$/, async (req, res) => {
    const rawSlug = req.params[0];
    const widthStr = req.params[1];

    let slug = '';
    try {
      slug = decodeURIComponent(rawSlug ?? '');
    } catch {
      slug = '';
    }
    if (!slug || !MEDIA_SLUG_REGEX.test(slug)) {
      res.status(404).type('text').send('Media not found.');
      return;
    }

    const width = Number.parseInt(widthStr ?? '', 10);
    if (!isValidDisplayWidth(width)) {
      const standardList = readStandardDisplayWidths()
        .slice()
        .sort((a, b) => a - b)
        .join(', ');
      res
        .status(400)
        .type('text')
        .send(
          `Width must be an integer 1-${MEDIA_MAX_DISPLAY_WIDTH}. Standard sizes: ${standardList}.`
        );
      return;
    }

    const wikimediaStep = resolveWikimediaStepForWidth(width);
    if (wikimediaStep === null) {
      // Defensive: isValidDisplayWidth caps at the largest canonical
      // step, so this branch is unreachable. Kept for safety in case
      // the canonical-steps list ever drifts.
      res.status(400).type('text').send('Invalid width.');
      return;
    }

    try {
      await initializePostgreSQL();
      const stored = await getOrFetchThumbnail(slug, wikimediaStep);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.sendFile(stored.path);
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).type('text').send('Media not found.');
        return;
      }
      if (err instanceof McpToolError) {
        const status = err.code === 'validation_error' ? 422 : 502;
        res.status(status).type('text').send(err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).type('text').send(`Failed to fetch thumbnail: ${message}`);
    }
  });

  // Standalone media metadata page.
  app.get(/^\/media\/(.+)$/, async (req, res) => {
    const rawSlug = req.params[0];
    let slug = '';
    try {
      slug = decodeURIComponent(rawSlug ?? '');
    } catch {
      slug = '';
    }
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;
    const formatParam = typeof req.query.format === 'string' ? req.query.format : undefined;
    const langParam = typeof req.query.lang === 'string' ? req.query.lang : undefined;
    const langOverride = normalizeOverrideLang(langParam);

    if (!slug) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      const dalInstance = await initializePostgreSQL();
      const result = await (async () => {
        try {
          const revisionsResult = await listMediaRevisions(dalInstance, slug);
          return { revisionsResult };
        } catch (error) {
          if (error instanceof NotFoundError) {
            res.status(404).type('text').send(req.t('page.notFound'));
            return null;
          }
          throw error;
        }
      })();
      if (!result) return;
      const { revisionsResult } = result;
      const revisions = revisionsResult.revisions;
      const userIds = revisions
        .map(rev => rev.revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const selectedRevision = revIdParam
        ? await (async () => {
            try {
              return (await readMediaRevision(dalInstance, slug, revIdParam)).revision;
            } catch (error) {
              if (error instanceof NotFoundError) {
                res.status(404).type('text').send(req.t('page.revisionNotFound'));
                return null;
              }
              throw error;
            }
          })()
        : revisions[0];
      if (!selectedRevision) return;

      const data = (selectedRevision.data ?? null) as unknown as MediaData | null;
      const revisionSlug = selectedRevision.slug ?? slug;
      const commonsTitle = selectedRevision.commonsTitle ?? '';
      const mediaType = (selectedRevision.mediaType ?? 'image') as MediaType;
      const pageTitle = formatMediaPageTitle(revisionSlug, commonsTitle);

      if (formatParam === 'raw') {
        res.type('application/json').send(formatMediaJson(data));
        return;
      }

      const captionMap = (selectedRevision.caption ?? null) as Record<string, string> | null;
      const altMap = (selectedRevision.altText ?? null) as Record<string, string> | null;
      const descriptionMap = (data?.description ?? null) as Record<string, string> | null;
      const availableLangs = getAvailableLanguages(captionMap, altMap, descriptionMap);
      const contentLang = resolveContentLanguage({
        uiLocale: res.locals.locale,
        override: langOverride,
        availableLangs,
      });
      const queryParams = extractQueryParams(req.query);

      const captionStr = captionMap ? mlString.resolve(contentLang, captionMap)?.str ?? '' : '';
      const altStr = altMap ? mlString.resolve(contentLang, altMap)?.str ?? '' : '';
      const descriptionStr = descriptionMap
        ? mlString.resolve(contentLang, descriptionMap)?.str ?? ''
        : '';

      const figureHtml =
        data && mediaType === 'image'
          ? formatMediaFigureHtml(
              { slug: revisionSlug, data },
              {
                caption: captionStr || undefined,
                alt: altStr || undefined,
                size: METADATA_PAGE_SIZE,
                revId: selectedRevision.revId,
              }
            )
          : '';

      const fields = [
        { label: req.t('media.field.slug'), value: revisionSlug },
        { label: req.t('media.field.commonsTitle'), value: commonsTitle, href: data?.commonsPageUrl },
        { label: req.t('media.field.mediaType'), value: mediaType },
        { label: req.t('media.field.mime'), value: data?.mime ?? '' },
        {
          label: req.t('media.field.dimensions'),
          value:
            data?.width && data?.height ? `${data.width} × ${data.height}` : '',
        },
        { label: req.t('media.field.license'), value: data?.license ?? '', href: data?.licenseUrl },
        { label: req.t('media.field.author'), value: data?.author ?? '' },
        { label: req.t('media.field.fetchedAt'), value: data?.fetchedAt ?? '' },
      ];

      const fieldsHtml = fields
        .filter(field => field.value)
        .map(field => {
          const value = String(field.value);
          const valueHtml = field.href
            ? `<a href="${escapeHtml(field.href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(value)}</a>`
            : escapeHtml(value);
          return `<div class="detail-field">
  <dt>${escapeHtml(field.label)}</dt>
  <dd>${valueHtml}</dd>
</div>`;
        })
        .join('\n');

      const descriptionHtml = descriptionStr
        ? `<div class="media-description">${escapeHtml(descriptionStr)}</div>`
        : '';
      const captionDisplayHtml = captionStr
        ? `<div class="media-default-caption"><strong>${escapeHtml(req.t('media.field.caption'))}:</strong> ${escapeHtml(captionStr)}</div>`
        : '';
      const altDisplayHtml = altStr
        ? `<div class="media-default-alt"><strong>${escapeHtml(req.t('media.field.altText'))}:</strong> ${escapeHtml(altStr)}</div>`
        : '';

      const revisionLabel = formatDateUTC(selectedRevision.revDate);
      const revisionMeta = revisionLabel
        ? req.t('media.revisionMeta', { revId: selectedRevision.revId, date: revisionLabel })
        : req.t('media.revisionMetaNoDate', { revId: selectedRevision.revId });
      const rawJson = formatMediaJson(data);

      const languageRow = renderContentLanguageRow({
        label: req.t('language.available'),
        currentLang: contentLang,
        availableLangs,
        languageOptions: res.locals.languageOptions,
        path: req.path,
        queryParams,
      });

      const bodyHtml = `<div class="media-card">
  <div class="media-figure-wrapper">${figureHtml}</div>
  <div class="media-meta">${escapeHtml(revisionMeta)}</div>
  ${descriptionHtml}
  ${captionDisplayHtml}
  ${altDisplayHtml}
  <dl class="detail-fields">${fieldsHtml}</dl>
  <details class="media-raw">
    <summary>${escapeHtml(req.t('media.rawJson'))}</summary>
    <pre>${escapeHtml(rawJson)}</pre>
  </details>
</div>${languageRow}`;

      let diffHtml = '';
      if (diffFrom && diffTo) {
        try {
          const diff = await diffMediaRevisions(dalInstance, {
            slug,
            fromRevId: diffFrom,
            toRevId: diffTo,
          });
          const fromLabel = formatDateUTC(diff.from.revDate)
            ? `${diff.fromRevId} (${formatDateUTC(diff.from.revDate)})`
            : diff.fromRevId;
          const toLabel = formatDateUTC(diff.to.revDate)
            ? `${diff.toRevId} (${formatDateUTC(diff.to.revDate)})`
            : diff.toRevId;
          const diffLabels = getDiffLabels(req.t);
          const baseHref = `/media/${encodeURIComponent(slug)}`;
          const fromHref = langOverride
            ? `${baseHref}?rev=${diffFrom}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffFrom}`;
          const toHref = langOverride
            ? `${baseHref}?rev=${diffTo}&lang=${encodeURIComponent(langOverride)}`
            : `${baseHref}?rev=${diffTo}`;
          const diffFields = Object.entries(diff.fields).map(([fieldKey, fieldDiff]) => ({
            key: fieldKey,
            diff: fieldDiff,
          }));
          diffHtml = renderEntityDiff({
            fromLabel,
            toLabel,
            fromHref,
            toHref,
            fields: diffFields,
            labels: diffLabels,
          });
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }

      const historyRevisions = revisions.map(rev => ({
        revId: rev.revId,
        dateLabel: formatDateUTC(rev.revDate),
        title: formatMediaLabel(rev.slug ?? revisionSlug, rev.commonsTitle ?? ''),
        summary: resolveSummary(rev.revSummary ?? null, contentLang),
        revUser: rev.revUser ?? null,
        revTags: rev.revTags ?? null,
      }));
      const historyAction = langOverride
        ? `/media/${encodeURIComponent(slug)}?lang=${encodeURIComponent(langOverride)}`
        : `/media/${encodeURIComponent(slug)}`;
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: historyAction,
        viewHref: revId =>
          langOverride
            ? `/media/${encodeURIComponent(slug)}?rev=${revId}&lang=${encodeURIComponent(langOverride)}`
            : `/media/${encodeURIComponent(slug)}?rev=${revId}`,
        userMap,
        t: req.t,
      });

      const labelHtml = `<div class="page-label">${req.t('label.media')}</div>`;
      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      res.render('layout', {
        title: prepareTitle(pageTitle),
        labelHtml,
        bodyHtml,
        topHtml: prependAccountBanner(res, topHtml),
        sidebarHtml: historyHtml,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render media:', message);
    }
  });
};
