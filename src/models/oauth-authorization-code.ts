import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
import oauthAuthorizationCodeManifest, {
  type OAuthAuthorizationCodeInstance,
  type OAuthAuthorizationCodeModel,
} from './manifests/oauth-authorization-code.js';

const oauthAuthorizationCodeStaticMethods = defineStaticMethods(oauthAuthorizationCodeManifest, {
  async findActiveByHash(
    this: OAuthAuthorizationCodeModel,
    codeHash: string
  ): Promise<OAuthAuthorizationCodeInstance | null> {
    const code = await this.filterWhere({ codeHash }).first();
    if (!code) return null;
    if (code.consumedAt) return null;
    if (code.expiresAt && code.expiresAt <= new Date()) return null;
    return code;
  },
});

export default defineModel(oauthAuthorizationCodeManifest, {
  staticMethods: oauthAuthorizationCodeStaticMethods,
});
