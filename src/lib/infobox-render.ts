import type { TFunction } from 'i18next';
import { escapeHtml } from '../render.js';
import { formatTime, type ParsedTime, parseLocalDate, parseWikidataTime, yearsBetween } from './infobox-dates.js';
import {
  CLASSIFICATION_RANKS,
  DATE_OF_BIRTH,
  DATE_OF_DEATH,
  findInfoboxDefinition,
  INFOBOX_DATE_PROPERTIES,
  type InfoboxRow,
  MEDIA_LEGEND,
  PLACE_OF_DEATH,
  TAXON_AUTHOR,
  TAXON_YEAR,
} from './infobox-definitions.js';
import type { InfoboxLocalValues } from './infobox-values.js';
import { GREGORIAN_CALENDAR, type WikidataSnapshot, type WikidataStatement, type WikidataValue } from './wikidata.js';

// Long lists show this many values, then "and N more".
export const MAX_LISTED_VALUES = 3;
const THUMBNAIL_WIDTH = 250;

// Wikidata label languages to try for each site locale, before "mul"
// (labels for all languages) and English.
const LABEL_LANGUAGES: Record<string, string[]> = {
  pt: ['pt-br', 'pt'],
  'pt-PT': ['pt'],
  zh: ['zh-hans', 'zh-cn', 'zh'],
  'zh-Hant': ['zh-hant', 'zh-tw', 'zh-hk', 'zh'],
};

export const labelLanguagesFor = (locale: string): string[] => {
  const own = LABEL_LANGUAGES[locale] ?? [locale.toLowerCase()];
  return [...new Set([...own, 'mul', 'en'])];
};

/** Every Wikidata language code the site's locales read labels in. */
export const wikidataLabelLanguages = (locales: readonly string[]): string[] => [
  ...new Set(locales.flatMap(labelLanguagesFor)),
];

export const wikidataItemUrl = (qid: string) => `https://www.wikidata.org/wiki/${encodeURIComponent(qid)}`;

export interface RenderInfoboxInput {
  snapshot: WikidataSnapshot | null;
  localValues?: InfoboxLocalValues | null;
  // The article title, already safe to put in HTML.
  titleHtml: string;
  locale: string;
  t: TFunction;
  // Viewing an older revision: the facts are today's, which the box says.
  isOldRevision?: boolean;
  now?: Date;
}

const capitalize = (text: string, locale: string) =>
  text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;

/**
 * The infobox for an article, or '' when its item has no box or the box
 * would be empty. Wikidata values come first; a value added on Agpedia is
 * shown only when Wikidata has none for that property, marked as such.
 */
export const renderInfobox = ({
  snapshot,
  localValues,
  titleHtml,
  locale,
  t,
  isOldRevision = false,
  now = new Date(),
}: RenderInfoboxInput): string => {
  const definition = findInfoboxDefinition(snapshot?.boxId);
  if (!snapshot || !definition) return '';
  const local = localValues ?? {};
  const hasFact = (property: string): boolean => Boolean(snapshot.claims[property]?.length || local[property]);
  const hasDeathEvidence = Boolean(snapshot.deathDateUnknown || [DATE_OF_DEATH, PLACE_OF_DEATH].some(hasFact));
  const languages = labelLanguagesFor(locale);

  const label = (id: string) => {
    const labels = snapshot.labels[id];
    for (const language of languages) {
      if (labels?.[language]) return labels[language];
    }
    return id;
  };
  const statementsOf = (property: string): WikidataStatement[] => {
    const statements = snapshot.claims[property] ?? [];
    if (!statements.some(statement => statement.value.type === 'monolingual')) return statements;
    for (const language of languages) {
      const preferred = statements.filter(
        statement => statement.value.type === 'monolingual' && statement.value.language.toLowerCase() === language
      );
      if (preferred.length) return preferred;
    }
    const first = statements.find(statement => statement.value.type === 'monolingual')?.value;
    return statements.filter(
      statement => statement.value.type === 'monolingual' &&
        first?.type === 'monolingual' && statement.value.language.toLowerCase() === first.language.toLowerCase()
    );
  };

  const formatValue = (value: WikidataValue): string => {
    switch (value.type) {
      case 'item':
        return escapeHtml(label(value.id));
      case 'time': {
        const parsed = parseWikidataTime(value.time, value.precision, value.calendarModel);
        return escapeHtml(parsed ? formatTime(parsed, locale, t) : value.time);
      }
      case 'monolingual':
        return escapeHtml(value.text);
      case 'quantity': {
        const amount = Number(value.amount);
        const number = Number.isFinite(amount) ? new Intl.NumberFormat(locale).format(amount) : value.amount;
        return escapeHtml(value.unit ? `${number} ${label(value.unit)}` : number);
      }
      case 'string': {
        if (value.datatype === 'url' && /^https?:\/\//i.test(value.value)) {
          const shown = value.value.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
          return `<a href="${escapeHtml(value.value)}" rel="nofollow noopener" target="_blank">${escapeHtml(shown)}</a>`;
        }
        return escapeHtml(value.value);
      }
    }
  };

  // A value added on Agpedia, with its citation and a mark saying so.
  const formatLocal = (property: string): string | null => {
    const entry = local[property];
    if (!entry) return null;
    const parsed = INFOBOX_DATE_PROPERTIES.has(property) ? parseLocalDate(entry.value) : null;
    const text = escapeHtml(parsed ? formatTime(parsed, locale, t) : entry.value);
    const href = `/cite/${encodeURIComponent(entry.citation)}`;
    return `${text} <span class="infobox-local">(<a href="${href}" title="${escapeHtml(
      t('infobox.addedOnAgpediaTitle')
    )}">${escapeHtml(t('infobox.addedOnAgpedia'))}</a>)</span>`;
  };

  // The first value of a property, from Wikidata or else from Agpedia.
  const single = (property: string | undefined): string | null => {
    if (!property) return null;
    const first = statementsOf(property)[0];
    return first ? formatValue(first.value) : formatLocal(property);
  };
  const timeOf = (property: string): ParsedTime | null => {
    const first = statementsOf(property)[0]?.value;
    if (first?.type === 'time') return parseWikidataTime(first.time, first.precision, first.calendarModel);
    const entry = local[property];
    return entry && INFOBOX_DATE_PROPERTIES.has(property) ? parseLocalDate(entry.value) : null;
  };

  // `alt` is HTML-safe text.
  const imageHtml = (file: string, alt: string, caption: string | null) => {
    const image = snapshot.images[file];
    const src = image?.thumbnailUrl;
    if (!image || !src) return '';
    const widthUrl = src.replace(/\/\d+px-/, `/${THUMBNAIL_WIDTH}px-`);
    const doubleUrl = src.replace(/\/\d+px-/, `/${THUMBNAIL_WIDTH * 2}px-`);
    return `<figure class="infobox-image"><a href="${escapeHtml(image.commonsPageUrl)}" rel="noopener" target="_blank"><img src="${escapeHtml(
      widthUrl
    )}" srcset="${escapeHtml(doubleUrl)} 2x" alt="${alt.replace(/"/g, '&quot;')}" loading="lazy" decoding="async"></a>${
      caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''
    }</figure>`;
  };

  const rowHtml = (heading: string, value: string) =>
    `<tr><th scope="row">${escapeHtml(heading)}</th><td>${value}</td></tr>`;

  const renderRow = (row: InfoboxRow): string => {
    const heading = t(`infobox.rows.${row.id}`);
    switch (row.kind) {
      case 'list': {
        const formatted = row.properties.flatMap(property => {
          const statements = statementsOf(property);
          if (!statements.length) {
            const value = formatLocal(property);
            return value === null ? [] : [value];
          }
          return statements.map(statement => formatValue(statement.value));
        });
        if (!formatted.length) return '';
        const firstProperty = row.properties.find(hasFact);
        const first = firstProperty ? statementsOf(firstProperty)[0]?.value : undefined;
        if (first?.type === 'item') formatted[0] = escapeHtml(capitalize(label(first.id), locale));
        if (formatted.length <= MAX_LISTED_VALUES + 1) return rowHtml(heading, formatted.join(', '));
        const more = formatted.length - MAX_LISTED_VALUES;
        const moreLink = `<a href="${wikidataItemUrl(snapshot.qid)}#${row.properties[0]}" rel="noopener" target="_blank">${escapeHtml(
          t('infobox.more', { count: more })
        )}</a>`;
        return rowHtml(
          heading,
          t('infobox.andMore', { list: formatted.slice(0, MAX_LISTED_VALUES).join(', '), more: moreLink, interpolation: { escapeValue: false } })
        );
      }
      case 'event': {
        const [dateProperty, placeProperty] = row.properties;
        const date = single(dateProperty);
        const place = single(placeProperty);
        if (!date && !place) return '';
        let age: number | null = null;
        if (row.age === 'sinceBirth' && !hasDeathEvidence) {
          const today = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(), precision: 11, calendarModel: GREGORIAN_CALENDAR };
          age = yearsBetween(timeOf(dateProperty), today);
        } else if (row.age === 'atDeath') {
          age = yearsBetween(timeOf(DATE_OF_BIRTH), timeOf(dateProperty));
        }
        const ageText =
          age === null
            ? ''
            : ` <span class="infobox-age">${escapeHtml(t(row.age === 'atDeath' ? 'infobox.agedAtDeath' : 'infobox.age', { count: age }))}</span>`;
        const lines = [date ? `${date}${ageText}` : '', place ?? ''].filter(Boolean);
        return rowHtml(heading, lines.join('<br>'));
      }
      case 'period': {
        const [startProperty, endProperty] = row.properties;
        const start = single(startProperty);
        const end = single(endProperty);
        if (!start && !end) return '';
        return rowHtml(heading, `${start ?? ''}–${end ?? escapeHtml(t('infobox.present'))}`);
      }
      case 'taxonName': {
        const statement = statementsOf(row.properties[0])[0];
        if (!statement) {
          const localName = formatLocal(row.properties[0]);
          return localName ? rowHtml(heading, localName) : '';
        }
        const authors = (statement.qualifiers?.[TAXON_AUTHOR] ?? []).map(formatValue);
        const year = (statement.qualifiers?.[TAXON_YEAR] ?? []).map(value => {
          const parsed = value.type === 'time' ? parseWikidataTime(value.time, value.precision, value.calendarModel) : null;
          return parsed ? formatTime({ ...parsed, precision: 9 }, locale, t) : '';
        })[0];
        const authority = [authors.join(', '), year].filter(Boolean).join(', ');
        return rowHtml(heading, `<i>${formatValue(statement.value)}</i>${authority ? ` (${authority})` : ''}`);
      }
      case 'classification':
        return snapshot.classification
          .map(step => {
            const rank = CLASSIFICATION_RANKS.find(candidate => candidate.id === step.rank);
            if (!rank) return '';
            // Scientific names are italic from the genus down.
            const name = escapeHtml(step.name ?? capitalize(label(step.taxon), locale));
            return rowHtml(t(`infobox.ranks.${rank.label}`), rank.label === 'genus' ? `<i>${name}</i>` : name);
          })
          .join('');
      case 'media': {
        const first = statementsOf(row.properties[0])[0]?.value;
        if (first?.type !== 'string') return '';
        const image = imageHtml(first.value, escapeHtml(heading), null);
        return image ? `<tr><td colspan="2" class="infobox-media">${image}<div>${escapeHtml(heading)}</div></td></tr>` : '';
      }
    }
  };

  const groupsHtml = definition.groups
    .map(group => {
      if (group.onlyWith && !group.onlyWith.some(hasFact)) return '';
      const rows = group.rows.map(renderRow).join('');
      if (!rows) return '';
      const heading = group.id
        ? `<tr><th colspan="2" class="infobox-heading" scope="colgroup">${escapeHtml(t(`infobox.groups.${group.id}`))}</th></tr>`
        : '';
      return `<tbody>${heading}${rows}</tbody>`;
    })
    .join('');

  let topImage = '';
  let topFile: string | null = null;
  for (const property of definition.imageProperties) {
    const statement = statementsOf(property)[0];
    if (statement?.value.type !== 'string') continue;
    const legend = (statement.qualifiers?.[MEDIA_LEGEND] ?? []).filter(value => value.type === 'monolingual');
    const caption = languages
      .map(language => legend.find(value => value.type === 'monolingual' && value.language.toLowerCase() === language))
      .find(value => value !== undefined) ?? null;
    topImage = imageHtml(statement.value.value, titleHtml, caption?.type === 'monolingual' ? caption.text : null);
    if (topImage) {
      topFile = statement.value.value;
      break;
    }
  }
  if (!groupsHtml && !topImage) return '';

  const image = topFile ? snapshot.images[topFile] : null;
  const creditHtml = image
    ? `<p class="infobox-credit">${escapeHtml(t('infobox.imageCredit'))} <a href="${escapeHtml(
        image.commonsPageUrl
      )}" rel="noopener" target="_blank">${escapeHtml(
        [image.author, image.license].filter(Boolean).join(', ') || image.file
      )}</a></p>`
    : '';
  const noteHtml = isOldRevision ? `<p class="infobox-note">${escapeHtml(t('infobox.oldRevisionNote'))}</p>` : '';

  return `<aside class="infobox infobox--${definition.id}" aria-label="${escapeHtml(t('infobox.ariaLabel'))}">
<div class="infobox-title">${titleHtml}</div>
${topImage}${groupsHtml ? `<table class="infobox-facts">${groupsHtml}</table>` : ''}
${noteHtml}${creditHtml}<p class="infobox-source"><a href="${wikidataItemUrl(snapshot.qid)}" rel="noopener" target="_blank">${escapeHtml(
    t('infobox.factsOnWikidata')
  )}</a></p>
</aside>`;
};
