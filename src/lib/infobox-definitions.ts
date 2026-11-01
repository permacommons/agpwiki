// Infobox definitions. Each box says which Wikidata items it applies to (by
// "instance of", P31), which properties it shows in which groups, and how a
// row is put together. The renderer in infobox-render.ts knows nothing about
// people, organisations or species: adding a box means adding a definition
// here, not new rendering code.

/**
 * How a row turns statements into text:
 * - `list`: every value of the listed properties, formatted by its Wikidata
 *   datatype and shortened when long ("a, b, c and 7 more").
 * - `event`: a date and a place, with an age ("born", "died", "founded").
 * - `period`: a start and an end date ("1986–present").
 * - `taxonName`: a scientific name with who described it and when.
 * - `classification`: one row per taxonomic rank, kingdom down to genus.
 * - `media`: a Commons file shown as a small image (a range map).
 */
export type InfoboxRowKind = 'list' | 'event' | 'period' | 'taxonName' | 'classification' | 'media';

export interface InfoboxRow {
  // Label key under `infobox.rows` in the locale files.
  id: string;
  kind: InfoboxRowKind;
  // Properties the row reads, in order. For `event`: [date, place]; for
  // `period`: [start, end]; for `taxonName`: [name]; for `media`: [file].
  properties: string[];
  // `event` only: show an age. "sinceBirth" is the age today, left out when
  // the item has a date of death; "atDeath" is the age when they died.
  age?: 'sinceBirth' | 'atDeath';
}

export interface InfoboxGroup {
  // Heading key under `infobox.groups`, or null for rows shown without one.
  id: string | null;
  rows: InfoboxRow[];
  // Show the group only when the item has one of these properties (the
  // musical career group is for people with instruments or record labels).
  onlyWith?: string[];
}

export interface InfoboxDefinition {
  id: string;
  // Items whose "instance of" (P31) is one of these classes get this box.
  instanceOf: string[];
  // Also match items that are instances of subclasses of those classes.
  includeSubclasses: boolean;
  // The first of these properties with a file gives the image at the top.
  imageProperties: string[];
  groups: InfoboxGroup[];
}

// Born and died ages are counted from the date of birth.
export const DATE_OF_BIRTH = 'P569';
export const DATE_OF_DEATH = 'P570';
// The caption of an image is its "media legend" qualifier.
export const MEDIA_LEGEND = 'P2096';
// Qualifiers of a scientific name: who described the taxon, and the year.
export const TAXON_AUTHOR = 'P405';
export const TAXON_YEAR = 'P574';
export const PARENT_TAXON = 'P171';
export const TAXON_RANK = 'P105';
export const INSTANCE_OF = 'P31';

// Ranks shown in a classification, kingdom down to genus, with the label key
// of each under `infobox.ranks`.
export const CLASSIFICATION_RANKS: Array<{ id: string; label: string }> = [
  { id: 'Q36732', label: 'kingdom' },
  { id: 'Q38348', label: 'phylum' },
  { id: 'Q37517', label: 'class' },
  { id: 'Q36602', label: 'order' },
  { id: 'Q35409', label: 'family' },
  { id: 'Q34740', label: 'genus' },
];

const list = (id: string, ...properties: string[]): InfoboxRow => ({ id, kind: 'list', properties });

export const INFOBOX_DEFINITIONS: InfoboxDefinition[] = [
  {
    id: 'person',
    instanceOf: ['Q5'],
    includeSubclasses: false,
    imageProperties: ['P18'],
    groups: [
      {
        id: 'personal',
        rows: [
          list('birthName', 'P1477'),
          { id: 'born', kind: 'event', properties: [DATE_OF_BIRTH, 'P19'], age: 'sinceBirth' },
          { id: 'died', kind: 'event', properties: [DATE_OF_DEATH, 'P20'], age: 'atDeath' },
          list('nationality', 'P27'),
          list('education', 'P69'),
          list('occupation', 'P106'),
          list('alsoKnownAs', 'P1449'),
          list('spouse', 'P26'),
          list('awards', 'P166'),
          list('website', 'P856'),
        ],
      },
      {
        id: 'musical',
        onlyWith: ['P1303', 'P264'],
        rows: [
          { id: 'yearsActive', kind: 'period', properties: ['P2031', 'P2032'] },
          list('genres', 'P136'),
          list('instruments', 'P1303'),
          list('labels', 'P264'),
          list('memberOf', 'P463'),
        ],
      },
      {
        id: 'political',
        rows: [list('positionsHeld', 'P39'), list('party', 'P102')],
      },
    ],
  },
  {
    id: 'organisation',
    instanceOf: ['Q43229'],
    includeSubclasses: true,
    imageProperties: ['P154', 'P18'],
    groups: [
      {
        id: null,
        rows: [
          { id: 'founded', kind: 'event', properties: ['P571', 'P740'] },
          list('founders', 'P112'),
          list('headquarters', 'P159'),
          list('type', INSTANCE_OF),
          list('industry', 'P452'),
          list('keyPeople', 'P169', 'P488', 'P1037'),
          list('employees', 'P1128'),
          list('parentOrganisation', 'P749'),
          list('website', 'P856'),
        ],
      },
    ],
  },
  {
    id: 'species',
    instanceOf: ['Q16521'],
    includeSubclasses: false,
    imageProperties: ['P18'],
    groups: [
      {
        id: null,
        rows: [
          { id: 'scientificName', kind: 'taxonName', properties: ['P225'] },
          list('commonName', 'P1843'),
          list('rank', TAXON_RANK),
          { id: 'classification', kind: 'classification', properties: [PARENT_TAXON] },
          list('conservationStatus', 'P141'),
          { id: 'rangeMap', kind: 'media', properties: ['P181'] },
        ],
      },
    ],
  },
];

export const findInfoboxDefinition = (id: string | null | undefined) =>
  INFOBOX_DEFINITIONS.find(definition => definition.id === id) ?? null;

/** Every property a box reads, its image included. */
export const definitionProperties = (definition: InfoboxDefinition): string[] => {
  const properties = new Set<string>([...definition.imageProperties]);
  for (const group of definition.groups) {
    for (const property of group.onlyWith ?? []) properties.add(property);
    for (const row of group.rows) {
      for (const property of row.properties) properties.add(property);
    }
  }
  // Ages are worked out from both dates.
  if (properties.has(DATE_OF_DEATH)) properties.add(DATE_OF_BIRTH);
  return [...properties];
};

/**
 * Properties an editor can give a value for on Agpedia: those shown as text
 * by some box. Images, range maps and the classification come from Wikidata
 * only.
 */
export const LOCAL_VALUE_PROPERTIES: ReadonlySet<string> = new Set(
  INFOBOX_DEFINITIONS.flatMap(definition =>
    definition.groups.flatMap(group =>
      group.rows
        .filter(row => row.kind !== 'media' && row.kind !== 'classification')
        .flatMap(row => row.properties)
    )
  )
);
