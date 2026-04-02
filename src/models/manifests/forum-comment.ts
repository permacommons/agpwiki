import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { mlString, types } = dal;

const forumCommentManifest = {
  tableName: 'forum_comments',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    threadId: types.string().uuid(4).required(),
    body: mlString.getHTMLSchema({ maxLength: 20000 }),
    originalLanguage: types.string().max(8),
    createdAt: types.date().default(() => new Date()),
    updatedAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    threadId: 'thread_id',
    originalLanguage: 'original_language',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type ForumCommentInstance = ManifestInstance<typeof forumCommentManifest>;
export type ForumCommentModel = ManifestModel<typeof forumCommentManifest>;

export function referenceForumComment(): ForumCommentModel {
  return referenceModel(forumCommentManifest) as ForumCommentModel;
}

export default forumCommentManifest;
