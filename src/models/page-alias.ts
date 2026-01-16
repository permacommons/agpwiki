import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
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
