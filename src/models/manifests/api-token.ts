import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const apiTokenManifest = {
  tableName: 'api_tokens',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    userId: types.string().uuid(4).required(),
    tokenHash: types.string().max(64).required(),
    tokenPrefix: types.string().max(8).required(),
    tokenLast4: types.string().max(4),
    label: types.string().max(128),
    createdAt: types.date().default(() => new Date()),
    lastUsedAt: types.date(),
    expiresAt: types.date(),
    revokedAt: types.date(),
  },
  camelToSnake: {
    userId: 'user_id',
    tokenHash: 'token_hash',
    tokenPrefix: 'token_prefix',
    tokenLast4: 'token_last4',
    createdAt: 'created_at',
    lastUsedAt: 'last_used_at',
    expiresAt: 'expires_at',
    revokedAt: 'revoked_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type ApiTokenInstance = ManifestInstance<typeof apiTokenManifest>;
export type ApiTokenModel = ManifestModel<typeof apiTokenManifest>;

export function referenceApiToken(): ApiTokenModel {
  return referenceModel(apiTokenManifest) as ApiTokenModel;
}

export default apiTokenManifest;
