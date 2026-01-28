import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import oauthClientManifest, {
  type OAuthClientInstance,
  type OAuthClientModel,
} from './manifests/oauth-client.js';

const oauthClientStaticMethods = defineStaticMethods(oauthClientManifest, {
  async findActiveByClientId(
    this: OAuthClientModel,
    clientId: string
  ): Promise<OAuthClientInstance | null> {
    const client = await this.filterWhere({ clientId }).first();
    if (!client) return null;
    if (client.revokedAt) return null;
    return client;
  },
});

export default defineModel(oauthClientManifest, { staticMethods: oauthClientStaticMethods });
