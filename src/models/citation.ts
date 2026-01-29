import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import citationManifest, { type CitationModel } from './manifests/citation.js';

const citationStaticMethods = defineStaticMethods(citationManifest, {
  async getByKey(this: CitationModel, key: string) {
    return this.filterWhere({ key }).first();
  },
});

export default defineModel(citationManifest, { staticMethods: citationStaticMethods });
