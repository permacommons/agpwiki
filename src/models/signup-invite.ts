import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import signupInviteManifest, { type SignupInviteModel } from './manifests/signup-invite.js';

const signupInviteStaticMethods = defineStaticMethods(signupInviteManifest, {
  async findActiveByHash(this: SignupInviteModel, codeHash: string) {
    const invite = await this.filterWhere({ codeHash }).first();
    if (!invite) return null;
    if (invite.revokedAt) return null;
    if (invite.usedAt) return null;
    if (invite.expiresAt && invite.expiresAt <= new Date()) return null;
    return invite;
  },
});

export default defineModel(signupInviteManifest, { staticMethods: signupInviteStaticMethods });
