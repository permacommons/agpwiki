import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

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
