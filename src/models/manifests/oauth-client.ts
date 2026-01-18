import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const oauthClientManifest = {
  tableName: 'oauth_clients',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    clientId: types.string().max(128).required(),
    clientSecretHash: types.string().max(64),
    clientSecretPrefix: types.string().max(8),
    clientSecretLast4: types.string().max(4),
    clientName: types.string().max(128),
    redirectUris: types.array(types.string()).required(),
    grantTypes: types.array(types.string()).required(),
    tokenEndpointAuthMethod: types.string().max(32).required(),
    createdAt: types.date().default(() => new Date()),
    revokedAt: types.date(),
  },
  camelToSnake: {
    clientId: 'client_id',
    clientSecretHash: 'client_secret_hash',
    clientSecretPrefix: 'client_secret_prefix',
    clientSecretLast4: 'client_secret_last4',
    clientName: 'client_name',
    redirectUris: 'redirect_uris',
    grantTypes: 'grant_types',
    tokenEndpointAuthMethod: 'token_endpoint_auth_method',
    createdAt: 'created_at',
    revokedAt: 'revoked_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type OAuthClientInstance = ManifestInstance<typeof oauthClientManifest>;
export type OAuthClientModel = ManifestModel<typeof oauthClientManifest>;

export function referenceOAuthClient(): OAuthClientModel {
  return referenceModel(oauthClientManifest) as OAuthClientModel;
}

export default oauthClientManifest;
