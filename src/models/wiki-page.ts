import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import wikiPageManifest, { type WikiPageModel } from './manifests/wiki-page.js';

const wikiPageStaticMethods = defineStaticMethods(wikiPageManifest, {
  async getBySlug(this: WikiPageModel, slug: string) {
    return this.filterWhere({ slug }).first();
  },
});

export default defineModel(wikiPageManifest, { staticMethods: wikiPageStaticMethods });
