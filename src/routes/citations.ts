import type { Express } from 'express';

import dal from 'rev-dal';
import { resolveSessionUser } from '../auth/session.js';
import { initializePostgreSQL } from '../db.js';
import {
  formatCitationAuthors,
  formatCitationIssued,
  formatCitationJson,
  formatCitationLabel,
  formatCitationPageTitle,
} from '../lib/citation.js';
import { resolveSafeText } from '../lib/safe-text.js';
import Citation from '../models/citation.js';
import CitationClaim from '../models/citation-claim.js';
import { escapeHtml, formatDateUTC, renderLayout, renderText } from '../render.js';
import { renderRevisionDiff } from './lib/diff.js';
import { fetchUserMap, renderRevisionHistory } from './lib/history.js';

const { mlString } = dal;

const normalizeField = (value: unknown) => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value.filter(entry => typeof entry === 'string').map(entry => entry.trim()).join('; ');
  }
  return '';
};

const resolveSummary = (value: Record<string, string> | null) =>
  resolveSafeText(mlString.resolve, 'en', value, '');

const findCurrentCitationByKey = async (key: string) =>
  Citation.filterWhere({
    key,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const findCurrentCitationClaim = async (citationId: string, claimId: string) =>
  CitationClaim.filterWhere({
    citationId,
    claimId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();

const formatLocatorLabel = (
  locatorType: string | null | undefined,
  locatorValue: string,
  locatorLabel: string
) => {
  if (locatorType === 'other') return locatorLabel || locatorValue || '';
  if (locatorType && locatorValue) return `${locatorType}: ${locatorValue}`;
  return locatorLabel || locatorValue || '';
};

const resolveLocatorStrings = (
  value: Record<string, string> | null | undefined,
  label: Record<string, string> | null | undefined,
  lang: string
) => ({
  locatorValue: mlString.resolve(lang, value ?? null)?.str ?? '',
  locatorLabel: mlString.resolve(lang, label ?? null)?.str ?? '',
});

const formatClaimDiffText = (
  claim: {
    claimId?: string | null;
    assertion?: Record<string, string> | null;
    quote?: Record<string, string> | null;
    quoteLanguage?: string | null;
    locatorType?: string | null;
    locatorValue?: Record<string, string> | null;
    locatorLabel?: Record<string, string> | null;
  },
  lang: string,
  t: (key: string, options?: Record<string, string>) => string
) => {
  const assertion = mlString.resolve(lang, claim.assertion ?? null)?.str ?? '';
  const quote = mlString.resolve(lang, claim.quote ?? null)?.str ?? '';
  const { locatorValue, locatorLabel } = resolveLocatorStrings(
    claim.locatorValue ?? null,
    claim.locatorLabel ?? null,
    lang
  );
  const locator = formatLocatorLabel(
    claim.locatorType ?? null,
    locatorValue,
    locatorLabel
  );
  return [
    t('citation.diff.claimId', { value: claim.claimId ?? '' }),
    t('citation.diff.assertion', { value: assertion }),
    t('citation.diff.quote', { value: quote }),
    t('citation.diff.quoteLanguage', { value: claim.quoteLanguage ?? '' }),
    t('citation.diff.locator', { value: locator }),
  ].join('\n');
};

export const registerCitationRoutes = (app: Express) => {
  app.get(/^\/cite\/(.+)\/claims\/([^/]+)$/, async (req, res) => {
    const rawKey = req.params[0];
    const rawClaimId = req.params[1];
    let key = '';
    let claimId = '';
    try {
      key = decodeURIComponent(rawKey ?? '');
      claimId = decodeURIComponent(rawClaimId ?? '');
    } catch {
      key = '';
      claimId = '';
    }
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;

    if (!key || !claimId) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();

      const citation = await findCurrentCitationByKey(key);
      if (!citation) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const claim = await findCurrentCitationClaim(citation.id, claimId);
      if (!claim) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const dalInstance = await initializePostgreSQL();
      const fetchRevisionByRevId = async (revId: string) => {
        return CitationClaim.filterWhere({}).getRevisionByRevId(revId, claim.id).first();
      };

      const revisions = await CitationClaim.filterWhere({})
        .getAllRevisions(claim.id)
        .orderBy('_revDate', 'DESC')
        .run();
      const userIds = revisions
        .map(rev => rev._revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const selectedRevision = revIdParam ? await fetchRevisionByRevId(revIdParam) : claim;
      if (revIdParam && !selectedRevision) {
        res.status(404).type('text').send(req.t('page.revisionNotFound'));
        return;
      }

      const assertion = resolveSafeText(mlString.resolve, 'en', selectedRevision.assertion, '');
      const quote = resolveSafeText(mlString.resolve, 'en', selectedRevision.quote, '');
      const { locatorValue, locatorLabel } = resolveLocatorStrings(
        selectedRevision.locatorValue ?? null,
        selectedRevision.locatorLabel ?? null,
        'en'
      );
      const locator = formatLocatorLabel(
        selectedRevision.locatorType ?? null,
        locatorValue,
        locatorLabel
      );
      const revisionLabel = formatDateUTC(selectedRevision._revDate);
      const revisionMeta = revisionLabel
        ? req.t('citation.revisionMeta', {
            revId: selectedRevision._revID,
            date: revisionLabel,
          })
        : req.t('citation.revisionMetaNoDate', { revId: selectedRevision._revID });

      const fields = [
        {
          label: req.t('citation.field.citation'),
          value: key,
          href: `/cite/${encodeURIComponent(key)}`,
        },
        { label: req.t('citation.field.claimId'), value: selectedRevision.claimId ?? claimId },
        { label: req.t('citation.field.assertion'), valueHtml: renderText(assertion) },
        quote
          ? {
              label: req.t('citation.field.quote'),
              valueHtml: `<blockquote class="citation-claim-quote">${renderText(
                quote
              )}</blockquote>`,
            }
          : null,
        { label: req.t('citation.field.quoteLanguage'), value: selectedRevision.quoteLanguage ?? '' },
        { label: req.t('citation.field.locator'), value: locator },
      ].filter(Boolean) as Array<{
        label: string;
        value?: string;
        valueHtml?: string;
        href?: string;
      }>;

      const fieldsHtml = fields
        .filter(field => field.value || field.valueHtml)
        .map(field => {
          const valueHtml = field.href
            ? `<a href="${escapeHtml(field.href)}">${escapeHtml(field.value ?? '')}</a>`
            : field.valueHtml ?? escapeHtml(field.value ?? '');
          return `<div class="citation-field">
  <dt>${escapeHtml(field.label)}</dt>
  <dd>${valueHtml}</dd>
</div>`;
        })
        .join('\n');

      let diffHtml = '';
      if (diffFrom && diffTo) {
        const fromRev = await fetchRevisionByRevId(diffFrom);
        const toRev = await fetchRevisionByRevId(diffTo);
        if (fromRev && toRev) {
          const fromText = formatClaimDiffText(fromRev, 'en', req.t);
          const toText = formatClaimDiffText(toRev, 'en', req.t);
          const fromLabel = formatDateUTC(fromRev._revDate)
            ? `${diffFrom} (${formatDateUTC(fromRev._revDate)})`
            : diffFrom;
          const toLabel = formatDateUTC(toRev._revDate)
            ? `${diffTo} (${formatDateUTC(toRev._revDate)})`
            : diffTo;
          diffHtml = renderRevisionDiff({
            fromLabel,
            toLabel,
            fromText,
            toText,
          });
        }
      }

      const historyRevisions = revisions.map(rev => ({
        revId: rev._revID,
        dateLabel: formatDateUTC(rev._revDate),
        title: rev.claimId ?? claimId,
        summary: resolveSummary(rev._revSummary ?? null),
        revUser: rev._revUser ?? null,
        revTags: rev._revTags ?? null,
      }));
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: `/cite/${encodeURIComponent(key)}/claims/${encodeURIComponent(claimId)}`,
        viewHref: revId =>
          `/cite/${encodeURIComponent(key)}/claims/${encodeURIComponent(claimId)}?rev=${revId}`,
        userMap,
        t: req.t,
      });

      const labelHtml = `<div class="page-label">${req.t('label.citation')}</div>`;
      const signedIn = Boolean(await resolveSessionUser(req));
      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const bodyHtml = `<div class="citation-card">
  <div class="citation-meta">${escapeHtml(revisionMeta)}</div>
  <dl class="citation-fields">${fieldsHtml}</dl>
</div>`;
      const html = renderLayout({
        title: `${claimId} · ${key}`,
        labelHtml,
        bodyHtml,
        topHtml,
        sidebarHtml: historyHtml,
        signedIn,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render citation claim:', message);
    }
  });

  app.get(/^\/cite\/(.+)$/, async (req, res) => {
    const rawKey = req.params[0];
    let key = '';
    try {
      key = decodeURIComponent(rawKey ?? '');
    } catch {
      key = '';
    }
    const revIdParam = typeof req.query.rev === 'string' ? req.query.rev : undefined;
    const diffFrom = typeof req.query.diffFrom === 'string' ? req.query.diffFrom : undefined;
    const diffTo = typeof req.query.diffTo === 'string' ? req.query.diffTo : undefined;
    const formatParam = typeof req.query.format === 'string' ? req.query.format : undefined;

    if (!key) {
      res.status(404).type('text').send(req.t('page.notFound'));
      return;
    }

    try {
      await initializePostgreSQL();

      const citation = await findCurrentCitationByKey(key);
      if (!citation) {
        res.status(404).type('text').send(req.t('page.notFound'));
        return;
      }

      const dalInstance = await initializePostgreSQL();
      const fetchRevisionByRevId = async (revId: string) => {
        return Citation.filterWhere({}).getRevisionByRevId(revId, citation.id).first();
      };

      const revisions = await Citation.filterWhere({})
        .getAllRevisions(citation.id)
        .orderBy('_revDate', 'DESC')
        .run();
      const userIds = revisions
        .map(rev => rev._revUser)
        .filter((id): id is string => Boolean(id));
      const userMap = await fetchUserMap(dalInstance, userIds);

      const selectedRevision = revIdParam ? await fetchRevisionByRevId(revIdParam) : citation;
      if (revIdParam && !selectedRevision) {
        res.status(404).type('text').send(req.t('page.revisionNotFound'));
        return;
      }

      const data = (selectedRevision.data ?? null) as Record<string, unknown> | null;
      const revisionKey = selectedRevision.key ?? key;
      const pageTitle = formatCitationPageTitle(revisionKey, data);

      if (formatParam === 'raw') {
        res.type('application/json').send(formatCitationJson(data));
        return;
      }

      const type = normalizeField(data?.type);
      const authors = formatCitationAuthors(data);
      const issued = formatCitationIssued(data);
      const containerTitle = normalizeField(data?.['container-title']);
      const publisher = normalizeField(data?.publisher);
      const publisherPlace = normalizeField(data?.['publisher-place']);
      const volume = normalizeField(data?.volume);
      const issue = normalizeField(data?.issue);
      const page = normalizeField(data?.page);
      const edition = normalizeField(data?.edition);
      const doi = normalizeField(data?.DOI);
      const url = normalizeField(data?.URL);
      const doiUrl = doi ? `https://doi.org/${doi}` : '';
      const rawJson = formatCitationJson(data);
      const revisionLabel = formatDateUTC(selectedRevision._revDate);
      const revisionMeta = revisionLabel
        ? req.t('citation.revisionMeta', {
            revId: selectedRevision._revID,
            date: revisionLabel,
          })
        : req.t('citation.revisionMetaNoDate', { revId: selectedRevision._revID });

      const claims = await CitationClaim.filterWhere({
        citationId: citation.id,
        _oldRevOf: null,
        _revDeleted: false,
      } as Record<string, unknown>)
        .orderBy('claimId', 'ASC')
        .run();

      const fields = [
        { label: req.t('citation.field.key'), value: revisionKey },
        { label: req.t('citation.field.authors'), value: authors },
        { label: req.t('citation.field.issued'), value: issued },
        { label: req.t('citation.field.type'), value: type },
        { label: req.t('citation.field.container'), value: containerTitle },
        { label: req.t('citation.field.publisher'), value: publisher },
        { label: req.t('citation.field.publisherPlace'), value: publisherPlace },
        { label: req.t('citation.field.volume'), value: volume },
        { label: req.t('citation.field.issue'), value: issue },
        { label: req.t('citation.field.pages'), value: page },
        { label: req.t('citation.field.edition'), value: edition },
        { label: req.t('citation.field.doi'), value: doi, href: doiUrl },
        { label: req.t('citation.field.url'), value: url, href: url },
      ];

      const fieldsHtml = fields
        .filter(field => field.value)
        .map(field => {
          const valueHtml = field.href
            ? `<a href="${escapeHtml(field.href)}">${escapeHtml(field.value)}</a>`
            : escapeHtml(field.value);
          return `<div class="citation-field">
  <dt>${escapeHtml(field.label)}</dt>
  <dd>${valueHtml}</dd>
</div>`;
        })
        .join('\n');

      const claimsHtml = claims.length
        ? `<section class="citation-claims">
  <h2>${req.t('citation.claimsTitle')}</h2>
  <ol class="citation-claims-list">${claims
    .map(claim => {
      const assertion = resolveSafeText(mlString.resolve, 'en', claim.assertion, '');
      const quote = resolveSafeText(mlString.resolve, 'en', claim.quote, '');
      const { locatorValue, locatorLabel } = resolveLocatorStrings(
        claim.locatorValue ?? null,
        claim.locatorLabel ?? null,
        'en'
      );
      const locator = formatLocatorLabel(
        claim.locatorType ?? null,
        locatorValue,
        locatorLabel
      );
      const metaParts = [
        locator ? req.t('citation.meta.locator', { locator: escapeHtml(locator) }) : '',
        claim.quoteLanguage
          ? req.t('citation.meta.quoteLanguage', { lang: escapeHtml(claim.quoteLanguage) })
          : '',
      ].filter(Boolean);
      const metaHtml = metaParts.length
        ? `<div class="citation-claim-meta">${metaParts.join(' · ')}</div>`
        : '';
      const quoteHtml = quote
        ? `<blockquote class="citation-claim-quote">"${renderText(quote)}"</blockquote>`
        : '';
      return `<li class="citation-claim" id="claim-${escapeHtml(claim.claimId)}">
  <div class="citation-claim-id"><a href="/cite/${encodeURIComponent(
    revisionKey
  )}/claims/${encodeURIComponent(claim.claimId)}">${escapeHtml(claim.claimId)}</a></div>
  <div class="citation-claim-assertion">${renderText(assertion)}</div>
  ${quoteHtml}
  ${metaHtml}
</li>`;
    })
    .join('\n')}</ol>
</section>`
        : '';

      const bodyHtml = `<div class="citation-card">
  <div class="citation-meta">${escapeHtml(revisionMeta)}</div>
  <dl class="citation-fields">${fieldsHtml}</dl>
  <details class="citation-raw">
    <summary>${req.t('citation.rawCsl')}</summary>
    <pre>${escapeHtml(rawJson)}</pre>
  </details>
</div>${claimsHtml}`;

      let diffHtml = '';
      if (diffFrom && diffTo) {
        const fromRev = await fetchRevisionByRevId(diffFrom);
        const toRev = await fetchRevisionByRevId(diffTo);
        if (fromRev && toRev) {
          const fromText = formatCitationJson(fromRev.data ?? null);
          const toText = formatCitationJson(toRev.data ?? null);
          const fromLabel = formatDateUTC(fromRev._revDate)
            ? `${diffFrom} (${formatDateUTC(fromRev._revDate)})`
            : diffFrom;
          const toLabel = formatDateUTC(toRev._revDate)
            ? `${diffTo} (${formatDateUTC(toRev._revDate)})`
            : diffTo;
          diffHtml = renderRevisionDiff({
            fromLabel,
            toLabel,
            fromText,
            toText,
          });
        }
      }

      const historyRevisions = revisions.map(rev => ({
        revId: rev._revID,
        dateLabel: formatDateUTC(rev._revDate),
        title: formatCitationLabel(
          rev.key ?? revisionKey,
          (rev.data ?? null) as Record<string, unknown> | null
        ),
        summary: resolveSummary(rev._revSummary ?? null),
        revUser: rev._revUser ?? null,
        revTags: rev._revTags ?? null,
      }));
      const historyHtml = renderRevisionHistory({
        revisions: historyRevisions,
        diffFrom,
        diffTo,
        action: `/cite/${encodeURIComponent(key)}`,
        viewHref: revId => `/cite/${encodeURIComponent(key)}?rev=${revId}`,
        userMap,
        t: req.t,
      });

      const labelHtml = `<div class="page-label">${req.t('label.citation')}</div>`;
      const signedIn = Boolean(await resolveSessionUser(req));
      const topHtml = diffHtml ? `<section class="diff-top">${diffHtml}</section>` : '';
      const html = renderLayout({
        title: pageTitle,
        labelHtml,
        bodyHtml,
        topHtml,
        sidebarHtml: historyHtml,
        signedIn,
        locale: res.locals.locale,
        languageOptions: res.locals.languageOptions,
      });
      res.type('html').send(html);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type('text').send(req.t('page.serverError'));
      console.error('Failed to render citation:', message);
    }
  });
};
