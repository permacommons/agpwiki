import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import agentAccessRequestManifest, {
  type AgentAccessRequestModel,
} from './manifests/agent-access-request.js';

const agentAccessRequestStaticMethods = defineStaticMethods(agentAccessRequestManifest, {
  async findForReview(this: AgentAccessRequestModel) {
    return this.orderBy('createdAt', 'DESC').run();
  },
});

export default defineModel(agentAccessRequestManifest, {
  staticMethods: agentAccessRequestStaticMethods,
});
