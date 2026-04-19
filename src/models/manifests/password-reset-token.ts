import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const passwordResetTokenManifest = {
  tableName: 'password_reset_tokens',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    userId: types.string().uuid(4).required(),
    email: types.string().max(254).required(),
    tokenHash: types.string().max(64).required(),
    tokenPrefix: types.string().max(8).required(),
    createdAt: types.date().default(() => new Date()),
    expiresAt: types.date().required(),
    usedAt: types.date(),
  },
  camelToSnake: {
    userId: 'user_id',
    tokenHash: 'token_hash',
    tokenPrefix: 'token_prefix',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
    usedAt: 'used_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type PasswordResetTokenInstance = ManifestInstance<typeof passwordResetTokenManifest>;
export type PasswordResetTokenModel = ManifestModel<typeof passwordResetTokenManifest>;

export function referencePasswordResetToken(): PasswordResetTokenModel {
  return referenceModel(passwordResetTokenManifest) as PasswordResetTokenModel;
}

export default passwordResetTokenManifest;
