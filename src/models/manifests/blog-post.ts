import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { mlString, types } = dal;

const blogPostManifest = {
  tableName: 'posts',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    slug: types.string().max(200).required(),
    title: mlString.getSafeTextSchema({ maxLength: 200 }),
    body: mlString.getHTMLSchema({ maxLength: 20000 }),
    summary: mlString.getSafeTextSchema({ maxLength: 500 }),
    originalLanguage: types.string().max(8),
    createdAt: types.date(),
    updatedAt: types.date(),
  },
  camelToSnake: {
    originalLanguage: 'original_language',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type BlogPostInstance = ManifestInstance<typeof blogPostManifest>;
export type BlogPostModel = ManifestModel<typeof blogPostManifest>;

export function referenceBlogPost(): BlogPostModel {
  return referenceModel(blogPostManifest) as BlogPostModel;
}

export default blogPostManifest;
