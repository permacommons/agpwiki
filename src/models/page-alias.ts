import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import pageAliasManifest, { type PageAliasModel } from './manifests/page-alias.js';

const pageAliasStaticMethods = defineStaticMethods(pageAliasManifest, {
  async getBySlug(this: PageAliasModel, slug: string) {
    return this.filterWhere({ slug }).first();
  },
  async listByPageId(this: PageAliasModel, pageId: string) {
    return this.filterWhere({ pageId }).orderBy('created_at');
  },
});

export default defineModel(pageAliasManifest, { staticMethods: pageAliasStaticMethods });
