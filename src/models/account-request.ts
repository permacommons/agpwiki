import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
import accountRequestManifest, { type AccountRequestModel } from './manifests/account-request.js';

const accountRequestStaticMethods = defineStaticMethods(accountRequestManifest, {
  async findPending(this: AccountRequestModel) {
    return this.filterWhere({ deletedAt: null }).orderBy('createdAt', 'DESC').run();
  },
});

export default defineModel(accountRequestManifest, { staticMethods: accountRequestStaticMethods });
