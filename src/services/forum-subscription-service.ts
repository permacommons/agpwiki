import ForumThreadSubscription from '../models/forum-thread-subscription.js';

export const subscribeUserToForumThread = async (threadId: string, userId: string) => {
  const existing = await ForumThreadSubscription.filterWhere({ threadId, userId }).first();
  if (existing) {
    if (existing.unsubscribedAt) {
      existing.unsubscribedAt = null;
      existing.subscribedAt = new Date();
      await existing.save();
    }
    return existing;
  }

  return ForumThreadSubscription.create({
    threadId,
    userId,
    subscribedAt: new Date(),
  });
};

export const unsubscribeUserFromForumThread = async (threadId: string, userId: string) => {
  const existing = await ForumThreadSubscription.filterWhere({ threadId, userId }).first();
  if (!existing) return null;
  if (!existing.unsubscribedAt) {
    existing.unsubscribedAt = new Date();
    await existing.save();
  }
  return existing;
};

export const isUserSubscribedToForumThread = async (threadId: string, userId: string) => {
  const existing = await ForumThreadSubscription.filterWhere({
    threadId,
    userId,
    unsubscribedAt: null,
  }).first();
  return Boolean(existing);
};

export const listActiveForumThreadSubscriberUserIds = async (threadId: string) => {
  const subscriptions = await ForumThreadSubscription.filterWhere({
    threadId,
    unsubscribedAt: null,
  }).run();
  return subscriptions.map(subscription => subscription.userId);
};
