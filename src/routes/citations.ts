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
import { escapeHtml, formatDateUTC, renderLayout } from '../render.js';
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

export const registerCitationRoutes = (app: Express) => {
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
        ? `Revision ${selectedRevision._revID} · ${revisionLabel}`
        : `Revision ${selectedRevision._revID}`;

      const fields = [
        { label: 'Key', value: revisionKey },
        { label: 'Authors', value: authors },
        { label: 'Issued', value: issued },
        { label: 'Type', value: type },
        { label: 'Container', value: containerTitle },
        { label: 'Publisher', value: publisher },
        { label: 'Publisher place', value: publisherPlace },
        { label: 'Volume', value: volume },
        { label: 'Issue', value: issue },
        { label: 'Pages', value: page },
        { label: 'Edition', value: edition },
        { label: 'DOI', value: doi, href: doiUrl },
        { label: 'URL', value: url, href: url },
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

      const bodyHtml = `<div class="citation-card">
  <div class="citation-meta">${escapeHtml(revisionMeta)}</div>
  <dl class="citation-fields">${fieldsHtml}</dl>
  <details class="citation-raw">
    <summary>Raw CSL JSON</summary>
    <pre>${escapeHtml(rawJson)}</pre>
  </details>
</div>`;

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
