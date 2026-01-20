import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('hex');
console.log(key);
