import dal from 'rev-dal';
import type { ManifestInstance, ManifestModel } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

const { types } = dal;

const forumThreadSubscriptionManifest = {
  tableName: 'forum_thread_subscriptions',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    threadId: types.string().uuid(4).required(),
    userId: types.string().uuid(4).required(),
    subscribedAt: types.date().default(() => new Date()),
    unsubscribedAt: types.date(),
  },
  camelToSnake: {
    threadId: 'thread_id',
    userId: 'user_id',
    subscribedAt: 'subscribed_at',
    unsubscribedAt: 'unsubscribed_at',
  },
  relations: [] as const,
} as const satisfies ModelManifest;

export type ForumThreadSubscriptionInstance =
  ManifestInstance<typeof forumThreadSubscriptionManifest>;
export type ForumThreadSubscriptionModel = ManifestModel<typeof forumThreadSubscriptionManifest>;

export function referenceForumThreadSubscription(): ForumThreadSubscriptionModel {
  return referenceModel(forumThreadSubscriptionManifest) as ForumThreadSubscriptionModel;
}

export default forumThreadSubscriptionManifest;
