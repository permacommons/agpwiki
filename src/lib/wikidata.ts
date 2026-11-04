import { MEDIA_LEGEND, TAXON_AUTHOR, TAXON_YEAR } from './infobox-definitions.js';

// What an infobox needs from Wikidata, reduced to plain JSON so it can be
// cached in the database and rendered without asking Wikidata again.

export const GREGORIAN_CALENDAR = 'http://www.wikidata.org/entity/Q1985727';
export const JULIAN_CALENDAR = 'http://www.wikidata.org/entity/Q1985786';

export type WikidataValue =
  | { type: 'item'; id: string }
  | { type: 'time'; time: string; precision: number; calendarModel?: string }
  | { type: 'string'; value: string; datatype: string }
  | { type: 'monolingual'; text: string; language: string }
  | { type: 'quantity'; amount: string; unit: string | null };

export interface WikidataStatement {
  value: WikidataValue;
  qualifiers?: Record<string, WikidataValue[]>;
}

export interface WikidataImage {
  file: string;
  thumbnailUrl: string | null;
  commonsPageUrl: string;
  author: string | null;
  license: string | null;
  licenseUrl: string | null;
}

export interface WikidataSnapshot {
  qid: string;
  // The box chosen for the item, or null when none applies.
  boxId: string | null;
  claims: Record<string, WikidataStatement[]>;
  deathDateUnknown?: boolean;
  // Labels of the items the claims point to, by item and language.
  labels: Record<string, Record<string, string>>;
  // Taxa above the item, kingdom first, with their scientific names.
  classification: Array<{ rank: string; taxon: string; name?: string }>;
  // Commons details of the files the box shows, by file name.
  images: Record<string, WikidataImage>;
}

interface ApiSnak {
  snaktype?: string;
  datatype?: string;
  datavalue?: { type?: string; value?: unknown };
}

interface ApiStatement {
  mainsnak?: ApiSnak;
  qualifiers?: Record<string, ApiSnak[]>;
  rank?: string;
}

export interface ApiEntity {
  id?: string;
  missing?: string;
  claims?: Record<string, ApiStatement[]>;
  labels?: Record<string, { language?: string; value?: string }>;
}

const ITEM_ID = /^Q[1-9][0-9]*$/;

/** Plain value of one snak, or null for "unknown value", "no value" and types not shown. */
export const simplifySnak = (snak: ApiSnak | undefined): WikidataValue | null => {
  if (!snak || snak.snaktype !== 'value' || !snak.datavalue) return null;
  const { type, value } = snak.datavalue;
  const record = (value ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'wikibase-entityid':
      return typeof record.id === 'string' && ITEM_ID.test(record.id) ? { type: 'item', id: record.id } : null;
    case 'time':
      return typeof record.time === 'string' && typeof record.precision === 'number'
        ? { type: 'time', time: record.time, precision: record.precision,
          calendarModel: typeof record.calendarmodel === 'string' ? record.calendarmodel : undefined }
        : null;
    case 'string':
      return typeof value === 'string' ? { type: 'string', value, datatype: snak.datatype ?? 'string' } : null;
    case 'monolingualtext':
      return typeof record.text === 'string' && typeof record.language === 'string'
        ? { type: 'monolingual', text: record.text, language: record.language }
        : null;
    case 'quantity': {
      if (typeof record.amount !== 'string') return null;
      const unit = typeof record.unit === 'string' ? record.unit.match(/\/(Q[1-9][0-9]*)$/)?.[1] ?? null : null;
      return { type: 'quantity', amount: record.amount, unit };
    }
    default:
      return null;
  }
};

export const rankedStatements = (statements: ApiStatement[] = []): ApiStatement[] => {
  const usable = statements.filter(statement => statement.rank !== 'deprecated');
  const preferred = usable.filter(statement => statement.rank === 'preferred');
  return preferred.length ? preferred : usable;
};

/**
 * The statements of one property as Wikidata ranks them: preferred
 * statements when there are any, otherwise the normal ones; deprecated
 * statements are dropped.
 */
export const simplifyStatements = (statements: ApiStatement[] | undefined): WikidataStatement[] => {
  const result: WikidataStatement[] = [];
  for (const statement of rankedStatements(statements)) {
    const value = simplifySnak(statement.mainsnak);
    if (!value) continue;
    const qualifiers: Record<string, WikidataValue[]> = {};
    for (const property of [MEDIA_LEGEND, TAXON_AUTHOR, TAXON_YEAR]) {
      const values = (statement.qualifiers?.[property] ?? [])
        .map(simplifySnak)
        .filter((qualifier): qualifier is WikidataValue => qualifier !== null);
      if (values.length) qualifiers[property] = values;
    }
    result.push(Object.keys(qualifiers).length ? { value, qualifiers } : { value });
  }
  return result;
};

export const itemIdsOf = (statements: WikidataStatement[]) => statements.map(s => s.value).filter(v => v.type === 'item').map(v => (v as { id: string }).id);
