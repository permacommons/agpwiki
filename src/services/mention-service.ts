import { decodeHTML } from 'entities';
import type { DataAccessLayer } from 'rev-dal/lib/data-access-layer';
import striptags from 'striptags';
import debug from '../../util/debug.js';
import { commentLinkPath } from '../lib/discussion-paths.js';
import { escapeHtml } from '../lib/html.js';
import { findMentionNames, MAX_MENTIONS_PER_POST, type MentionMap } from '../lib/mentions.js';
import { collapseWhitespace, EXCERPT_LENGTH, pickLocalizedText, truncate } from '../lib/notification-text.js';
import { normalizeUsername } from '../lib/username.js';
import ForumComment from '../models/forum-comment.js';
import ForumThread from '../models/forum-thread.js';
import PageSignoff from '../models/page-signoff.js';
import User from '../models/user.js';
import { findMarkdownMentionNames } from '../render.js';
import { sendMail } from './email-service.js';
import { deliverNotification, loadNotificationRecipients } from './notification-delivery-service.js';
import { enqueueNotificationJob, type NotificationJobRecord } from './notification-queue.js';
import { markdownToPlainText } from './notification-text.js';
import { findCurrentPageById } from './page-lookup-service.js';
import { getSiteBaseUrl } from './site-config.js';
import { findCurrentPageBySlugOrAlias } from './wiki-page-service.js';

export const MENTION_NOTIFICATION = 'mention.created';
const MENTION_KIND = 'mention';

/** A post that can mention people: a forum comment or a position's comment. */
export type MentionSource = { type: 'comment'; threadId: string; commentId: string } | { type: 'position'; signoffId: string };

export type MentionPayload = MentionSource & {
  actorUserId: string;
  recipientUserIds: string[];
};

type EnqueueJob = (type: string, payload: MentionPayload) => Promise<unknown>;

/** Which of these normalized names are usernames: name -> account. */
export const resolveMentionedUsers = async (dal: DataAccessLayer, names: string[]) => {
  const users = new Map<string, { id: string; username: string }>();
  if (!names.length) return users;
  const result = await dal.query('SELECT id, username FROM users WHERE username = ANY($1)', [names]);
  for (const row of result.rows as Array<{ id: string; username: string }>) {
    users.set(row.username, { id: row.id, username: row.username });
  }
  return users;
};

/** The usernames mentioned in these Markdown texts, for rendering them. */
export const loadMarkdownMentions = async (dal: DataAccessLayer, sources: string[]): Promise<MentionMap> => {
  const names = [...new Set(sources.flatMap(source => (source.includes('@') ? findMarkdownMentionNames(source) : [])))];
  const users = await resolveMentionedUsers(dal, names);
  return new Map([...users].map(([name, user]) => [name, user.username]));
};

/** The usernames mentioned in these plain texts (position comments). */
export const loadPlainTextMentions = async (dal: DataAccessLayer, texts: string[]): Promise<MentionMap> => {
  const names = [...new Set(texts.flatMap(text => findMentionNames(text)))];
  const users = await resolveMentionedUsers(dal, names);
  return new Map([...users].map(([name, user]) => [name, user.username]));
};

const namesIn = (text: string, format: 'markdown' | 'plain') =>
  !text.includes('@') ? [] : format === 'markdown' ? findMarkdownMentionNames(text) : findMentionNames(text);

// Real accounts mentioned in a text, in the order written, without the
// author and at most MAX_MENTIONS_PER_POST.
const mentionedUserIds = async (
  dal: DataAccessLayer,
  text: string,
  format: 'markdown' | 'plain',
  actorUserId: string,
  limit = MAX_MENTIONS_PER_POST
) => {
  const names = namesIn(text, format);
  if (!names.length || limit <= 0) return [];
  const users = await resolveMentionedUsers(dal, names);
  const ids: string[] = [];
  for (const name of names) {
    const id = users.get(name)?.id;
    if (!id || id === actorUserId || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length === limit) break;
  }
  return ids;
};

/**
 * The people a post notifies. An edit passes the earlier text: people
 * mentioned there were notified already, and count toward the limit.
 */
export const listMentionRecipientUserIds = async (
  dal: DataAccessLayer,
  { text, previousText, format, actorUserId }: {
    text: string;
    previousText?: string | null;
    format: 'markdown' | 'plain';
    actorUserId: string;
  }
) => {
  const earlier = previousText ? await mentionedUserIds(dal, previousText, format, actorUserId) : [];
  const ids = await mentionedUserIds(dal, text, format, actorUserId, Number.POSITIVE_INFINITY);
  return ids.filter(id => !earlier.includes(id)).slice(0, MAX_MENTIONS_PER_POST - earlier.length);
};

/** People mentioned in a forum comment, as notified when it was posted. */
export const listCommentMentionRecipientUserIds = async (
  dal: DataAccessLayer,
  comment: { body?: Record<string, string> | null; canonicalLanguage?: string | null },
  actorUserId: string
) =>
  listMentionRecipientUserIds(dal, {
    text: pickLocalizedText(comment.body, comment.canonicalLanguage),
    format: 'markdown',
    actorUserId,
  });

/**
 * Notify the people a new or edited post mentions. Failures are logged, not
 * thrown: the post itself is already saved.
 */
export const notifyMentions = async (
  dal: DataAccessLayer,
  source: MentionSource,
  {
    text,
    previousText,
    actorUserId,
  }: { text: string; previousText?: string | null; actorUserId: string },
  enqueueJob: EnqueueJob = enqueueNotificationJob
) => {
  try {
    const recipientUserIds = await listMentionRecipientUserIds(dal, {
      text,
      previousText,
      format: source.type === 'comment' ? 'markdown' : 'plain',
      actorUserId,
    });
    if (!recipientUserIds.length) return null;
    return await enqueueJob(MENTION_NOTIFICATION, { ...source, actorUserId, recipientUserIds });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const id = source.type === 'comment' ? source.commentId : source.signoffId;
    debug.error(`Failed to enqueue mention notifications for ${source.type} ${id}: ${message}`);
    return null;
  }
};

const pagePath = (slug: string) => `/${slug.split('/').map(encodeURIComponent).join('/')}`;

const titleText = (value: Record<string, string> | null | undefined, language?: string | null) =>
  collapseWhitespace(decodeHTML(striptags(pickLocalizedText(value, language))));

/** Where the mention is, what to call that place, and the start of the text. */
const describe = async (dal: DataAccessLayer, payload: MentionPayload) => {
  if (payload.type === 'position') {
    const signoff = await PageSignoff.filterWhere({ id: payload.signoffId, withdrawnAt: null } as Record<
      string,
      unknown
    >).first();
    const page = signoff ? await findCurrentPageById(signoff.pageId) : null;
    if (!signoff || !page) return null;
    return {
      url: `${pagePath(page.slug)}#position-${encodeURIComponent(signoff.id)}`,
      subject: titleText(page.title, page.canonicalLanguage) || page.slug,
      excerpt: truncate(collapseWhitespace(signoff.comment ?? ''), EXCERPT_LENGTH),
    };
  }
  const comment = await ForumComment.filterWhere({
    id: payload.commentId,
    threadId: payload.threadId,
    _oldRevOf: null,
    _revDeleted: false,
  } as Record<string, unknown>).first();
  const thread = await ForumThread.filterWhere({ id: payload.threadId, _oldRevOf: null, _revDeleted: false } as Record<
    string,
    unknown
  >).first();
  if (!comment || !thread) return null;
  // Replies to a position belong to the proposal; their thread has no title
  // of its own to show.
  const proposal =
    thread.attachedType === 'position' && thread.pageSlug ? await findCurrentPageBySlugOrAlias(thread.pageSlug) : null;
  return {
    url: commentLinkPath(
      {
        id: thread.id,
        category: thread.category,
        pageSlug: thread.pageSlug,
        attachedType: thread.attachedType,
        attachedId: thread.attachedId,
      },
      comment.id
    ),
    subject: proposal
      ? titleText(proposal.title, proposal.canonicalLanguage) || proposal.slug
      : titleText(thread.title, thread.canonicalLanguage) || thread.id,
    excerpt: truncate(
      await markdownToPlainText(dal, pickLocalizedText(comment.body, comment.canonicalLanguage)),
      EXCERPT_LENGTH
    ),
  };
};

export const processMentionNotification = async (
  dal: DataAccessLayer,
  job: NotificationJobRecord<MentionPayload>,
  sendMailFn: typeof sendMail = sendMail
) => {
  const payload = job.payload;
  const recipients = await loadNotificationRecipients(payload.recipientUserIds ?? [], MENTION_KIND);
  if (recipients.length === 0) return { sentCount: 0, siteCount: 0 };
  const rendered = await describe(dal, payload);
  if (!rendered) return { sentCount: 0, siteCount: 0, skipped: 'post_not_found' as const };
  const actor = await User.filterWhere({ id: payload.actorUserId }).first();
  const actorName = actor?.displayName ?? 'Someone';
  const baseUrl = getSiteBaseUrl();
  const link = `${baseUrl}${rendered.url}`;
  const settingsUrl = `${baseUrl}/tool/settings`;
  const lead = `${actorName} mentioned you in "${rendered.subject}".`;
  return deliverNotification(dal, job.id, recipients, {
    kind: MENTION_KIND,
    actorUserId: payload.actorUserId,
    url: rendered.url,
    subject: rendered.subject,
    excerpt: rendered.excerpt || null,
  }, user => ({
    to: user.email,
    subject: `${actorName} mentioned you in: ${rendered.subject}`,
    text: [
      lead,
      ...(rendered.excerpt ? ['', rendered.excerpt] : []),
      '',
      `Open it: ${link}`,
      `Notification settings: ${settingsUrl}`,
    ].join('\n'),
    html: `<p>${escapeHtml(lead)}</p>
${rendered.excerpt ? `<blockquote>${escapeHtml(rendered.excerpt)}</blockquote>\n` : ''}<p><a href="${escapeHtml(link)}">Open it</a></p>
<p><a href="${escapeHtml(settingsUrl)}">Notification settings</a></p>`,
  }), sendMailFn);
};

export const MENTION_SUGGESTION_LIMIT = 8;

/**
 * A few usernames starting with what someone typed after @, for the
 * suggestions under a comment box. Blocked accounts are left out.
 */
export const suggestMentionUsernames = async (dal: DataAccessLayer, typed: string) => {
  const prefix = normalizeUsername(typed);
  if (!prefix || prefix.includes('@')) return [];
  const pattern = `${prefix.replace(/[\\%_]/g, char => `\\${char}`)}%`;
  const result = await dal.query(
    `SELECT username, display_name FROM users
      WHERE username LIKE $1 AND blocked_at IS NULL
      ORDER BY username = $2 DESC, length(username), username
      LIMIT $3`,
    [pattern, prefix, MENTION_SUGGESTION_LIMIT]
  );
  return (result.rows as Array<{ username: string; display_name: string }>).map(row => ({
    username: row.username,
    name: row.display_name,
  }));
};
