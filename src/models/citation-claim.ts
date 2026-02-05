import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import citationClaimManifest, { type CitationClaimModel } from './manifests/citation-claim.js';

const citationClaimStaticMethods = defineStaticMethods(citationClaimManifest, {
  async getByClaimId(this: CitationClaimModel, citationId: string, claimId: string) {
    return this.filterWhere({ citationId, claimId }).first();
  },
});

export default defineModel(citationClaimManifest, {
  staticMethods: citationClaimStaticMethods,
});
