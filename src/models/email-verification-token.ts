import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import emailVerificationTokenManifest, {
  type EmailVerificationTokenModel,
} from './manifests/email-verification-token.js';

const emailVerificationTokenStaticMethods = defineStaticMethods(emailVerificationTokenManifest, {
  async findActiveByHash(this: EmailVerificationTokenModel, tokenHash: string) {
    const token = await this.filterWhere({ tokenHash }).first();
    if (!token) return null;
    if (token.usedAt) return null;
    if (token.expiresAt <= new Date()) return null;
    return token;
  },
});

export default defineModel(emailVerificationTokenManifest, {
  staticMethods: emailVerificationTokenStaticMethods,
});
