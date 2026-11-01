import {
  CLASSIFICATION_RANKS,
  definitionProperties,
  INFOBOX_DEFINITIONS,
  INSTANCE_OF,
  type InfoboxDefinition,
  MEDIA_LEGEND,
  TAXON_AUTHOR,
  TAXON_YEAR,
} from './infobox-definitions.js';

// What an infobox needs from Wikidata, reduced to plain JSON so it can be
// cached in the database and rendered without asking Wikidata again.

export type WikidataValue =
  | { type: 'item'; id: string }
  | { type: 'time'; time: string; precision: number }
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
  // Labels of the items the claims point to, by item and language.
  labels: Record<string, Record<string, string>>;
  // Taxa above the item, kingdom first, with their scientific names.
  classification: Array<{ rank: string; taxon: string; name?: string }>;
  // Commons details of the files the box shows, by file name.
  images: Record<string, WikidataImage>;
}

export interface WikidataFetchOptions {
  fetchImpl?: typeof fetch;
  apiBaseUrl: string;
  sparqlUrl: string;
  userAgent: string;
  timeoutMs: number;
  // Languages to fetch labels in (Wikidata codes).
  languages: string[];
  // Loads Commons details of a file; failures leave the image out.
  fetchImage?: (file: string) => Promise<WikidataImage | null>;
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

interface ApiEntity {
  id?: string;
  missing?: string;
  claims?: Record<string, ApiStatement[]>;
  labels?: Record<string, { language?: string; value?: string }>;
}

const ITEM_ID = /^Q[1-9][0-9]*$/;
const LABEL_BATCH_SIZE = 50;

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
        ? { type: 'time', time: record.time, precision: record.precision }
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

/**
 * The statements of one property as Wikidata ranks them: preferred
 * statements when there are any, otherwise the normal ones; deprecated
 * statements are dropped.
 */
export const simplifyStatements = (statements: ApiStatement[] | undefined): WikidataStatement[] => {
  if (!statements?.length) return [];
  const usable = statements.filter(statement => statement.rank !== 'deprecated');
  const preferred = usable.filter(statement => statement.rank === 'preferred');
  const chosen = preferred.length ? preferred : usable;
  const result: WikidataStatement[] = [];
  for (const statement of chosen) {
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

const itemIdsOf = (statements: WikidataStatement[]) => statements.map(s => s.value).filter(v => v.type === 'item').map(v => (v as { id: string }).id);

/**
 * The box for an item from its "instance of" classes: a direct match first,
 * then, for boxes that include subclasses, the answer to `inSubclassOf`.
 */
export const chooseInfoboxDefinition = async (
  instanceOf: string[],
  inSubclassOf: (roots: string[]) => Promise<Set<string>>
): Promise<InfoboxDefinition | null> => {
  const direct = INFOBOX_DEFINITIONS.find(definition =>
    definition.instanceOf.some(root => instanceOf.includes(root))
  );
  if (direct) return direct;
  const withSubclasses = INFOBOX_DEFINITIONS.filter(definition => definition.includeSubclasses);
  if (!instanceOf.length || !withSubclasses.length) return null;
  const matched = await inSubclassOf(withSubclasses.flatMap(definition => definition.instanceOf));
  return withSubclasses.find(definition => definition.instanceOf.some(root => matched.has(root))) ?? null;
};

/**
 * Fetches what the infobox of item `qid` shows: the item's statements for
 * the chosen box, the labels of the items they point to, the classification
 * of a taxon and the Commons details of its images.
 */
export const fetchWikidataSnapshot = async (
  qid: string,
  options: WikidataFetchOptions
): Promise<WikidataSnapshot> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const getJson = async (url: string, accept = 'application/json') => {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': options.userAgent, Accept: accept },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`Wikidata returned status ${response.status}.`);
    return (await response.json()) as Record<string, unknown>;
  };
  const api = (params: Record<string, string>) =>
    getJson(`${options.apiBaseUrl}?${new URLSearchParams({ format: 'json', ...params }).toString()}`);
  const sparql = async (query: string) => {
    const data = await getJson(
      `${options.sparqlUrl}?${new URLSearchParams({ query, format: 'json' }).toString()}`,
      'application/sparql-results+json'
    );
    const bindings = (data.results as { bindings?: Array<Record<string, { value?: string }>> } | undefined)?.bindings;
    return bindings ?? [];
  };
  const entityId = (binding: { value?: string } | undefined) => binding?.value?.match(/\/(Q[1-9][0-9]*)$/)?.[1] ?? null;

  const entityData = await api({ action: 'wbgetentities', ids: qid, props: 'claims' });
  const entities = (entityData.entities ?? {}) as Record<string, ApiEntity>;
  // A merged item answers under the ID it was merged into.
  const entity = entities[qid] ?? Object.values(entities)[0];
  const empty: WikidataSnapshot = { qid, boxId: null, claims: {}, labels: {}, classification: [], images: {} };
  if (!entity || entity.missing !== undefined) return empty;
  const allClaims = entity.claims ?? {};

  const instanceOf = itemIdsOf(simplifyStatements(allClaims[INSTANCE_OF]));
  const definition = await chooseInfoboxDefinition(instanceOf, async roots => {
    const rows = await sparql(
      `SELECT DISTINCT ?root WHERE { VALUES ?root { ${roots.map(root => `wd:${root}`).join(' ')} } wd:${qid} wdt:P31/wdt:P279* ?root . }`
    );
    return new Set(rows.map(row => entityId(row.root)).filter((id): id is string => id !== null));
  });
  if (!definition) return empty;

  const claims: Record<string, WikidataStatement[]> = {};
  for (const property of definitionProperties(definition)) {
    const statements = simplifyStatements(allClaims[property]);
    if (statements.length) claims[property] = statements;
  }

  const classification: WikidataSnapshot['classification'] = [];
  if (definition.groups.some(group => group.rows.some(row => row.kind === 'classification'))) {
    const rows = await sparql(
      `SELECT ?taxon ?rank ?name WHERE { VALUES ?rank { ${CLASSIFICATION_RANKS.map(rank => `wd:${rank.id}`).join(' ')} } wd:${qid} wdt:P171* ?taxon . ?taxon wdt:P105 ?rank . OPTIONAL { ?taxon wdt:P225 ?name . } }`
    );
    for (const rank of CLASSIFICATION_RANKS) {
      const row = rows.find(candidate => entityId(candidate.rank) === rank.id);
      const taxon = entityId(row?.taxon);
      if (!taxon || taxon === qid) continue;
      const name = row?.name?.value;
      classification.push(name ? { rank: rank.id, taxon, name } : { rank: rank.id, taxon });
    }
  }

  // Labels of every item the box may show.
  const itemIds = new Set<string>();
  for (const statements of Object.values(claims)) {
    for (const statement of statements) {
      const values = [statement.value, ...Object.values(statement.qualifiers ?? {}).flat()];
      for (const value of values) {
        if (value.type === 'item') itemIds.add(value.id);
        if (value.type === 'quantity' && value.unit) itemIds.add(value.unit);
      }
    }
  }
  for (const step of classification) if (!step.name) itemIds.add(step.taxon);
  const labels: WikidataSnapshot['labels'] = {};
  const ids = [...itemIds];
  for (let start = 0; start < ids.length; start += LABEL_BATCH_SIZE) {
    const batch = ids.slice(start, start + LABEL_BATCH_SIZE);
    const labelData = await api({
      action: 'wbgetentities',
      ids: batch.join('|'),
      props: 'labels',
      languages: options.languages.join('|'),
    });
    for (const [id, labelled] of Object.entries((labelData.entities ?? {}) as Record<string, ApiEntity>)) {
      const byLanguage: Record<string, string> = {};
      for (const [language, label] of Object.entries(labelled.labels ?? {})) {
        if (typeof label.value === 'string') byLanguage[language] = label.value;
      }
      if (Object.keys(byLanguage).length) labels[id] = byLanguage;
    }
  }

  // Commons details of the image at the top and of media rows.
  const images: WikidataSnapshot['images'] = {};
  if (options.fetchImage) {
    const mediaProperties = new Set(definition.imageProperties);
    for (const group of definition.groups) {
      for (const row of group.rows) {
        if (row.kind !== 'media') continue;
        for (const property of row.properties) mediaProperties.add(property);
      }
    }
    const files = new Set<string>();
    for (const property of mediaProperties) {
      const first = claims[property]?.[0]?.value;
      if (first?.type === 'string') files.add(first.value);
    }
    for (const file of files) {
      const image = await options.fetchImage(file).catch(() => null);
      if (image) images[file] = image;
    }
  }

  return { qid, boxId: definition.id, claims, labels, classification, images };
};
