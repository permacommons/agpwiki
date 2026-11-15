import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import User from '../models/user.js';

export const loadUserDisplayNames = async (_dalInstance: DataAccessLayer, userIds: Iterable<string>) => {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map<string, string>();
  const users = await User.filterWhere({}).whereIn('id', ids).select('id', 'displayName');
  return new Map(users.map(user => [user.id, user.displayName]));
};

export const loadUserAuthors = async (_dalInstance: DataAccessLayer, userIds: Iterable<string>) => {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map<string, { name: string; username: string }>();
  const users = await User.filterWhere({}).whereIn('id', ids).select('id', 'displayName', 'username');
  return new Map(users.map(user => [user.id, { name: user.displayName, username: user.username }]));
};
