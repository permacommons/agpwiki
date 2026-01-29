import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const oauthAuthorizationCodeManifest = {
  tableName: 'oauth_authorization_codes',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    codeHash: types.string().max(64).required(),
    codePrefix: types.string().max(8).required(),
    clientId: types.string().max(128).required(),
    userId: types.string().uuid(4).required(),
    redirectUri: types.string().required(),
    scopes: types.array(types.string()).required(),
    codeChallenge: types.string().required(),
    codeChallengeMethod: types.string().max(16).required(),
    createdAt: types.date().default(() => new Date()),
    expiresAt: types.date().required(),
    consumedAt: types.date(),
  },
  camelToSnake: {
    codeHash: 'code_hash',
    codePrefix: 'code_prefix',
    clientId: 'client_id',
    userId: 'user_id',
    redirectUri: 'redirect_uri',
    codeChallenge: 'code_challenge',
    codeChallengeMethod: 'code_challenge_method',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
    consumedAt: 'consumed_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type OAuthAuthorizationCodeInstance = ManifestInstance<typeof oauthAuthorizationCodeManifest>;
export type OAuthAuthorizationCodeModel = ManifestModel<typeof oauthAuthorizationCodeManifest>;

export function referenceOAuthAuthorizationCode(): OAuthAuthorizationCodeModel {
  return referenceModel(oauthAuthorizationCodeManifest) as OAuthAuthorizationCodeModel;
}

export default oauthAuthorizationCodeManifest;
