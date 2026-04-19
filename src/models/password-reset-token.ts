import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import passwordResetTokenManifest, {
  type PasswordResetTokenModel,
} from './manifests/password-reset-token.js';

const passwordResetTokenStaticMethods = defineStaticMethods(passwordResetTokenManifest, {
  async findActiveByHash(this: PasswordResetTokenModel, tokenHash: string) {
    const token = await this.filterWhere({ tokenHash }).first();
    if (!token) return null;
    if (token.usedAt) return null;
    if (token.expiresAt <= new Date()) return null;
    return token;
  },
});

export default defineModel(passwordResetTokenManifest, {
  staticMethods: passwordResetTokenStaticMethods,
});
