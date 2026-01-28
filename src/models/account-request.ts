import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import accountRequestManifest, { type AccountRequestModel } from './manifests/account-request.js';

const accountRequestStaticMethods = defineStaticMethods(accountRequestManifest, {
  async findPending(this: AccountRequestModel) {
    return this.filterWhere({ deletedAt: null }).orderBy('createdAt', 'DESC').run();
  },
});

export default defineModel(accountRequestManifest, { staticMethods: accountRequestStaticMethods });
