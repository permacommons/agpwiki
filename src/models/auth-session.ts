import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
import authSessionManifest, { type AuthSessionModel } from './manifests/auth-session.js';

const authSessionStaticMethods = defineStaticMethods(authSessionManifest, {
  async findActiveByHash(this: AuthSessionModel, tokenHash: string) {
    const session = await this.filterWhere({ tokenHash }).first();
    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt && session.expiresAt <= new Date()) return null;
    return session;
  },
});

export default defineModel(authSessionManifest, { staticMethods: authSessionStaticMethods });
