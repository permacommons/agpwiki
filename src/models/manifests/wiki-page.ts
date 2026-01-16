import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { mlString, types } = dal;

const wikiPageManifest = {
  tableName: 'pages',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    slug: types.string().max(200).required(),
    title: mlString.getSafeTextSchema({ maxLength: 200 }),
    body: mlString.getHTMLSchema({ maxLength: 20000 }),
    originalLanguage: types.string().max(8),
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

export type WikiPageInstance = ManifestInstance<typeof wikiPageManifest>;
export type WikiPageModel = ManifestModel<typeof wikiPageManifest>;

export function referenceWikiPage(): WikiPageModel {
  return referenceModel(wikiPageManifest) as WikiPageModel;
}

export default wikiPageManifest;
