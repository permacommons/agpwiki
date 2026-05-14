import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import mediaManifest, { type MediaModel } from './manifests/media.js';

const mediaStaticMethods = defineStaticMethods(mediaManifest, {
  async getBySlug(this: MediaModel, slug: string) {
    return this.filterWhere({ slug }).first();
  },
  async getByCommonsTitle(this: MediaModel, commonsTitle: string) {
    return this.filterWhere({ commonsTitle }).first();
  },
});

export default defineModel(mediaManifest, { staticMethods: mediaStaticMethods });
