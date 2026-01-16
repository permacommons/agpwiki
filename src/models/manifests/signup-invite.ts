import dal from '../../../dal/index.js';
import type { ManifestInstance, ManifestModel } from '../../../dal/lib/create-model.js';
import { referenceModel } from '../../../dal/lib/model-handle.js';
import type { ModelManifest } from '../../../dal/lib/model-manifest.js';

const { types } = dal;

const signupInviteManifest = {
  tableName: 'signup_invites',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    codeHash: types.string().max(64).required(),
    codePrefix: types.string().max(8).required(),
    email: types.string().max(254),
    role: types.string().max(64),
    issuedBy: types.string().uuid(4),
    createdAt: types.date().default(() => new Date()),
    expiresAt: types.date(),
    usedAt: types.date(),
    usedBy: types.string().uuid(4),
    revokedAt: types.date(),
  },
  camelToSnake: {
    codeHash: 'code_hash',
    codePrefix: 'code_prefix',
    issuedBy: 'issued_by',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
    usedAt: 'used_at',
    usedBy: 'used_by',
    revokedAt: 'revoked_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type SignupInviteInstance = ManifestInstance<typeof signupInviteManifest>;
export type SignupInviteModel = ManifestModel<typeof signupInviteManifest>;

export function referenceSignupInvite(): SignupInviteModel {
  return referenceModel(signupInviteManifest) as SignupInviteModel;
}

export default signupInviteManifest;
