import { listRoles } from '../services/roles.js';

const roles = listRoles();

console.log('Available roles:');
for (const entry of roles) {
  console.log(`- ${entry.role}: ${entry.description}`);
}
