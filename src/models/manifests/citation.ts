import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const citationManifest = {
  tableName: 'citations',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    key: types.string().max(200).required(),
    data: types.object().required(),
    createdAt: types.date().default(() => new Date()),
    updatedAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type CitationInstance = ManifestInstance<typeof citationManifest>;
export type CitationModel = ManifestModel<typeof citationManifest>;

export function referenceCitation(): CitationModel {
  return referenceModel(citationManifest) as CitationModel;
}

export default citationManifest;
