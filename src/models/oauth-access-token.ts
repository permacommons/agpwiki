import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
import oauthAccessTokenManifest, {
  type OAuthAccessTokenInstance,
  type OAuthAccessTokenModel,
} from './manifests/oauth-access-token.js';

const oauthAccessTokenStaticMethods = defineStaticMethods(oauthAccessTokenManifest, {
  async findActiveByHash(
    this: OAuthAccessTokenModel,
    tokenHash: string
  ): Promise<OAuthAccessTokenInstance | null> {
    const token = await this.filterWhere({ tokenHash }).first();
    if (!token) return null;
    if (token.revokedAt) return null;
    if (token.expiresAt && token.expiresAt <= new Date()) return null;
    return token;
  },
});

export default defineModel(oauthAccessTokenManifest, { staticMethods: oauthAccessTokenStaticMethods });
