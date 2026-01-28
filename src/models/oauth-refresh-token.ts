import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import oauthRefreshTokenManifest, {
  type OAuthRefreshTokenInstance,
  type OAuthRefreshTokenModel,
} from './manifests/oauth-refresh-token.js';

const oauthRefreshTokenStaticMethods = defineStaticMethods(oauthRefreshTokenManifest, {
  async findActiveByHash(
    this: OAuthRefreshTokenModel,
    tokenHash: string
  ): Promise<OAuthRefreshTokenInstance | null> {
    const token = await this.filterWhere({ tokenHash }).first();
    if (!token) return null;
    if (token.revokedAt) return null;
    if (token.expiresAt && token.expiresAt <= new Date()) return null;
    if (token.rotatedAt) return null;
    return token;
  },
});

export default defineModel(oauthRefreshTokenManifest, {
  staticMethods: oauthRefreshTokenStaticMethods,
});
