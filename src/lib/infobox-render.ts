import type { TFunction } from 'i18next';
import { escapeHtml } from '../render.js';
import {
  CLASSIFICATION_RANKS,
  DATE_OF_BIRTH,
  DATE_OF_DEATH,
  findInfoboxDefinition,
  type InfoboxRow,
  MEDIA_LEGEND,
  TAXON_AUTHOR,
  TAXON_YEAR,
} from './infobox-definitions.js';
import type { WikidataSnapshot, WikidataStatement, WikidataValue } from './wikidata.js';

// A value an editor added on Agpedia for a fact Wikidata lacks, keyed by
// Wikidata property in the page's properties.
export interface InfoboxLocalValue {
  value: string;
  citation: string;
}
export type InfoboxLocalValues = Record<string, InfoboxLocalValue>;

export interface InfoboxMismatch {
  property: string;
  agpediaValue: string;
  wikidataValue: string;
}

// Properties whose values are dates, so values added on Agpedia (written
// 1964, 1964-05 or 1964-05-30) are formatted like Wikidata's.
const TIME_PROPERTIES = new Set([DATE_OF_BIRTH, DATE_OF_DEATH, 'P571', 'P2031', 'P2032']);

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

interface ParsedTime {
  year: number;
  month: number;
  day: number;
  precision: number;
}

const parseWikidataTime = (time: string, precision: number): ParsedTime | null => {
  const match = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(time);
  if (!match) return null;
  const year = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return { year, month: Number(match[3]), day: Number(match[4]), precision };
};

/** A date written on Agpedia (1964, 1964-05 or 1964-05-30), or null. */
export const parseLocalDate = (value: string): ParsedTime | null => {
  const match = /^(-?)(\d{1,4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return {
    year,
    month: match[3] ? Number(match[3]) : 0,
    day: match[4] ? Number(match[4]) : 0,
    precision: match[4] ? 11 : match[3] ? 10 : 9,
  };
};

const toDate = (parsed: ParsedTime) => {
  const date = new Date(Date.UTC(2000, Math.max(parsed.month, 1) - 1, Math.max(parsed.day, 1)));
  date.setUTCFullYear(parsed.year);
  return date;
};

const formatTime = (parsed: ParsedTime, locale: string, t: TFunction): string => {
  if (parsed.year <= 0) return t('infobox.yearBce', { year: 1 - parsed.year });
  if (parsed.precision >= 11 && parsed.month && parsed.day) {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
      toDate(parsed)
    );
  }
  if (parsed.precision === 10 && parsed.month) {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(toDate(parsed));
  }
  if (parsed.precision === 8) return t('infobox.decade', { year: Math.floor(parsed.year / 10) * 10 });
  // A century is shown as its years, "1800s".
  if (parsed.precision === 7) return t('infobox.decade', { year: Math.floor((parsed.year - 1) / 100) * 100 });
  return String(parsed.year);
};

/** Whole years from `from` to `to`, when both dates are known to the day. */
const yearsBetween = (from: ParsedTime | null, to: ParsedTime | null): number | null => {
  if (!from || !to || from.precision < 11 || to.precision < 11) return null;
  let years = to.year - from.year;
  if (to.month < from.month || (to.month === from.month && to.day < from.day)) years -= 1;
  return years >= 0 ? years : null;
};

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
    // Text in several languages: the reader's, otherwise the first one.
    const own = statements.filter(
      statement => statement.value.type === 'monolingual' && languages.includes(statement.value.language.toLowerCase())
    );
    return own.length ? own : statements.slice(0, 1);
  };

  const formatValue = (value: WikidataValue): string => {
    switch (value.type) {
      case 'item':
        return escapeHtml(label(value.id));
      case 'time': {
        const parsed = parseWikidataTime(value.time, value.precision);
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
    const parsed = TIME_PROPERTIES.has(property) ? parseLocalDate(entry.value) : null;
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
    if (first?.type === 'time') return parseWikidataTime(first.time, first.precision);
    const entry = local[property];
    return entry && TIME_PROPERTIES.has(property) ? parseLocalDate(entry.value) : null;
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
        const values = row.properties.flatMap(property => statementsOf(property).map(statement => statement.value));
        if (!values.length) {
          const locals = row.properties.map(formatLocal).filter((text): text is string => text !== null);
          return locals.length ? rowHtml(heading, locals.join(', ')) : '';
        }
        const formatted = values.map(formatValue);
        if (values[0].type === 'item') formatted[0] = escapeHtml(capitalize(label((values[0] as { id: string }).id), locale));
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
        if (row.age === 'sinceBirth' && !timeOf(DATE_OF_DEATH)) {
          const today = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate(), precision: 11 };
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
          const parsed = value.type === 'time' ? parseWikidataTime(value.time, value.precision) : null;
          return parsed ? String(parsed.year) : '';
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
      if (group.onlyWith && !group.onlyWith.some(property => snapshot.claims[property]?.length)) return '';
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
    const caption =
      legend.find(value => value.type === 'monolingual' && languages.includes(value.language.toLowerCase())) ?? null;
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

// Text of a value for comparing and for the mismatch record, in English.
const plainText = (snapshot: WikidataSnapshot, value: WikidataValue): string => {
  switch (value.type) {
    case 'item':
      return snapshot.labels[value.id]?.en ?? snapshot.labels[value.id]?.mul ?? value.id;
    case 'time':
      return value.time.replace(/^\+/, '').slice(0, value.precision >= 11 ? 10 : value.precision === 10 ? 7 : 4).replace(/^0+(?=\d)/, '');
    case 'monolingual':
      return value.text;
    case 'quantity':
      return value.amount.replace(/^\+/, '');
    case 'string':
      return value.value;
  }
};

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

const valueMatches = (snapshot: WikidataSnapshot, property: string, local: string, value: WikidataValue): boolean => {
  if (value.type === 'time' && TIME_PROPERTIES.has(property)) {
    const mine = parseLocalDate(local);
    const theirs = parseWikidataTime(value.time, value.precision);
    if (!mine || !theirs) return false;
    // Equal as far as both are known: 1964 matches 1964-05-30.
    if (mine.year !== theirs.year) return false;
    if (mine.precision >= 10 && theirs.precision >= 10 && mine.month !== theirs.month) return false;
    if (mine.precision >= 11 && theirs.precision >= 11 && mine.day !== theirs.day) return false;
    return true;
  }
  if (value.type === 'item') {
    if (local.trim() === value.id) return true;
    return Object.values(snapshot.labels[value.id] ?? {}).some(text => normalize(text) === normalize(local));
  }
  if (value.type === 'quantity') return Number(local.replace(/[\s,]/g, '')) === Number(value.amount);
  return normalize(plainText(snapshot, value)) === normalize(local);
};

/**
 * Values added on Agpedia that differ from what Wikidata now has for the
 * same property. Values for properties Wikidata has nothing for are not
 * mismatches: they fill a gap.
 */
export const findInfoboxMismatches = (
  snapshot: WikidataSnapshot | null,
  localValues: InfoboxLocalValues | null | undefined
): InfoboxMismatch[] => {
  if (!snapshot || !localValues) return [];
  const mismatches: InfoboxMismatch[] = [];
  for (const [property, entry] of Object.entries(localValues)) {
    const statements = snapshot.claims[property] ?? [];
    if (!statements.length) continue;
    if (statements.some(statement => valueMatches(snapshot, property, entry.value, statement.value))) continue;
    mismatches.push({
      property,
      agpediaValue: entry.value,
      wikidataValue: statements.map(statement => plainText(snapshot, statement.value)).join('; '),
    });
  }
  return mismatches;
};
