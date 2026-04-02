import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import forumCommentManifest, { type ForumCommentModel } from './manifests/forum-comment.js';

const forumCommentStaticMethods = defineStaticMethods(forumCommentManifest, {
  async getById(this: ForumCommentModel, id: string) {
    return this.filterWhere({ id }).first();
  },
});

export default defineModel(forumCommentManifest, {
  staticMethods: forumCommentStaticMethods,
});
