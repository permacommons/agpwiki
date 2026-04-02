import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { mlString, types } = dal;

const forumThreadManifest = {
  tableName: 'forum_threads',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    category: types.string().max(32).required(),
    title: mlString.getSafeTextSchema({ maxLength: 200 }),
    originalLanguage: types.string().max(8),
    pinned: types.number().default(() => 0),
    createdAt: types.date().default(() => new Date()),
    updatedAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    originalLanguage: 'original_language',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type ForumThreadInstance = ManifestInstance<typeof forumThreadManifest>;
export type ForumThreadModel = ManifestModel<typeof forumThreadManifest>;

export function referenceForumThread(): ForumThreadModel {
  return referenceModel(forumThreadManifest) as ForumThreadModel;
}

export default forumThreadManifest;
