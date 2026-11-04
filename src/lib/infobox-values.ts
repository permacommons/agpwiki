// A value an editor added on Agpedia for a fact Wikidata lacks, keyed by
// Wikidata property in the page's properties.
export interface InfoboxLocalValue {
  value: string;
  citation: string;
}
export type InfoboxLocalValues = Record<string, InfoboxLocalValue>;
