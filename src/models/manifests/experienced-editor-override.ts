import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const experiencedEditorOverrideManifest = {
  tableName: 'experienced_editor_overrides',
  hasRevisions: false as const,
  schema: {
    userId: types.string().uuid(4).required(),
    status: types.string().max(16).required(),
    reason: types.string(),
    decidedBy: types.string().uuid(4),
    decidedAt: types.date().default(() => new Date()),
  },
  camelToSnake: {
    userId: 'user_id',
    decidedBy: 'decided_by',
    decidedAt: 'decided_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type ExperiencedEditorOverrideInstance = ManifestInstance<typeof experiencedEditorOverrideManifest>;
export type ExperiencedEditorOverrideModel = ManifestModel<typeof experiencedEditorOverrideManifest>;

export function referenceExperiencedEditorOverride(): ExperiencedEditorOverrideModel {
  return referenceModel(experiencedEditorOverrideManifest) as ExperiencedEditorOverrideModel;
}

export default experiencedEditorOverrideManifest;
