// Kinds of notifications people can choose a channel for. Each kind gets its
// own row in the settings.
export const NOTIFICATION_KINDS = ['forum.reply', 'page.revert', 'page.comment'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CHANNELS = ['both', 'site', 'email', 'none'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DEFAULT_NOTIFICATION_CHANNEL: NotificationChannel = 'both';

// Comments on followed pages can be frequent, so they stay on the site
// unless someone asks for email too.
const KIND_DEFAULTS: Partial<Record<NotificationKind, NotificationChannel>> = {
  'page.comment': 'site',
};

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(value);

export const isNotificationChannel = (value: unknown): value is NotificationChannel =>
  typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);

export const readNotificationChannel = (preferences: unknown, kind: NotificationKind): NotificationChannel => {
  const value = (preferences as Record<string, unknown> | null | undefined)?.[kind];
  return isNotificationChannel(value) ? value : (KIND_DEFAULTS[kind] ?? DEFAULT_NOTIFICATION_CHANNEL);
};

export const wantsSiteNotification = (channel: NotificationChannel) => channel === 'both' || channel === 'site';
export const wantsEmailNotification = (channel: NotificationChannel) => channel === 'both' || channel === 'email';
