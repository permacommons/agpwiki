import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
import citationManifest, { type CitationModel } from './manifests/citation.js';

const citationStaticMethods = defineStaticMethods(citationManifest, {
  async getByKey(this: CitationModel, key: string) {
    return this.filterWhere({ key }).first();
  },
});

export default defineModel(citationManifest, { staticMethods: citationStaticMethods });
