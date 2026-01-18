import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const oauthRefreshTokenManifest = {
  tableName: 'oauth_refresh_tokens',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    tokenHash: types.string().max(64).required(),
    tokenPrefix: types.string().max(8).required(),
    tokenLast4: types.string().max(4),
    clientId: types.string().max(128).required(),
    userId: types.string().uuid(4).required(),
    scopes: types.array(types.string()).required(),
    issuedAt: types.date().default(() => new Date()),
    expiresAt: types.date().required(),
    rotatedAt: types.date(),
    revokedAt: types.date(),
  },
  camelToSnake: {
    tokenHash: 'token_hash',
    tokenPrefix: 'token_prefix',
    tokenLast4: 'token_last4',
    clientId: 'client_id',
    userId: 'user_id',
    issuedAt: 'issued_at',
    expiresAt: 'expires_at',
    rotatedAt: 'rotated_at',
    revokedAt: 'revoked_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type OAuthRefreshTokenInstance = ManifestInstance<typeof oauthRefreshTokenManifest>;
export type OAuthRefreshTokenModel = ManifestModel<typeof oauthRefreshTokenManifest>;

export function referenceOAuthRefreshToken(): OAuthRefreshTokenModel {
  return referenceModel(oauthRefreshTokenManifest) as OAuthRefreshTokenModel;
}

export default oauthRefreshTokenManifest;
