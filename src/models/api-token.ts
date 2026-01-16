import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
import apiTokenManifest, {
  type ApiTokenInstance,
  type ApiTokenModel,
} from './manifests/api-token.js';

const apiTokenStaticMethods = defineStaticMethods(apiTokenManifest, {
  async findActiveByHash(this: ApiTokenModel, tokenHash: string): Promise<ApiTokenInstance | null> {
    const token = await this.filterWhere({ tokenHash }).first();
    if (!token) return null;
    if (token.revokedAt) return null;
    if (token.expiresAt && token.expiresAt <= new Date()) return null;
    return token;
  },
});

export default defineModel(apiTokenManifest, { staticMethods: apiTokenStaticMethods });
