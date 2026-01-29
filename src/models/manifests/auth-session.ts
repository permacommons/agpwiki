import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const authSessionManifest = {
  tableName: 'auth_sessions',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    userId: types.string().uuid(4).required(),
    tokenHash: types.string().max(64).required(),
    tokenPrefix: types.string().max(8).required(),
    createdAt: types.date().default(() => new Date()),
    lastUsedAt: types.date(),
    expiresAt: types.date(),
    revokedAt: types.date(),
  },
  camelToSnake: {
    userId: 'user_id',
    tokenHash: 'token_hash',
    tokenPrefix: 'token_prefix',
    createdAt: 'created_at',
    lastUsedAt: 'last_used_at',
    expiresAt: 'expires_at',
    revokedAt: 'revoked_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type AuthSessionInstance = ManifestInstance<typeof authSessionManifest>;
export type AuthSessionModel = ManifestModel<typeof authSessionManifest>;

export function referenceAuthSession(): AuthSessionModel {
  return referenceModel(authSessionManifest) as AuthSessionModel;
}

export default authSessionManifest;
