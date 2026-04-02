import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import forumThreadManifest, { type ForumThreadModel } from './manifests/forum-thread.js';

const forumThreadStaticMethods = defineStaticMethods(forumThreadManifest, {
  async getById(this: ForumThreadModel, id: string) {
    return this.filterWhere({ id }).first();
  },
});

export default defineModel(forumThreadManifest, {
  staticMethods: forumThreadStaticMethods,
});
