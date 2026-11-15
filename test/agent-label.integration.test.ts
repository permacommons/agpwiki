import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import i18next from 'i18next';
import './_setup-i18n.js';

import { initializePostgreSQL } from '../src/db.js';
import { ForbiddenError } from '../src/lib/errors.js';
import { createMcpServer } from '../src/mcp/core.js';
import { renderAgentLabel } from '../src/routes/lib/forum-comment-editor.js';
import { renderPageSignoffs } from '../src/routes/lib/page-signoffs.js';
import {
  createForumComment,
  createForumThread,
  findForumCommentAuthorId,
  listForumCommentVersions,
  readForumComment,
  removeForumCommentAgentLabel,
} from '../src/services/forum-service.js';
import { signOffPage } from '../src/services/page-signoff-service.js';
import { createWikiPage } from '../src/services/wiki-page-service.js';
import { insertTestUser } from './_test-users.js';

type Dal = Awaited<ReturnType<typeof initializePostgreSQL>>;

let sharedDal: Dal | null = null;
const getDal = async () => {
  sharedDal ??= await initializePostgreSQL();
  return sharedDal;
};
test.after(async () => {
  if (sharedDal) {
    await sharedDal.disconnect();
    sharedDal = null;
  }
});

const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const createTestUser = (name: string) =>
  insertTestUser({ prefix: `agentlabel${name}`, displayName: `Operator ${name}`, emailVerified: true });

type ToolHandler = (
  args: unknown,
  extra?: { authInfo?: { extra?: { userId?: string } } }
) => Promise<{ isError?: boolean; structuredContent: unknown }>;

const mcpAs = (clientName: string | null) => {
  const { server } = createMcpServer({ skipPolicyCheck: true });
  // The client name an MCP client sends when it connects.
  (server.server as unknown as { getClientVersion: () => unknown }).getClientVersion = () =>
    clientName ? { name: clientName, version: '1.2.3' } : undefined;
  const tools = (server as unknown as {
    _registeredTools: Record<string, { handler: ToolHandler; inputSchema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: Array<{ path: unknown[]; message: string }> } } } }>;
  })._registeredTools;
  return { server, tools };
};

test('proposal_replyToPosition requires reviewedByOperator, with no default', () => {
  const { tools } = mcpAs(null);
  const schema = tools.proposal_replyToPosition.inputSchema;
  const base = { slug: 'meta/proposals/x', signoffId: crypto.randomUUID(), body: 'Hi', bodyLanguage: 'en', policyHash: 'x' };
  const missing = schema.safeParse(base);
  assert.equal(missing.success, false);
  assert.ok(missing.error?.issues.some(issue => issue.path[0] === 'reviewedByOperator'));
  assert.equal(schema.safeParse({ ...base, reviewedByOperator: 'no' }).success, false);
  assert.equal(schema.safeParse({ ...base, reviewedByOperator: false }).success, true);
});

test('Agent replies are labelled with the client name; reviewed and web replies are not', async () => {
  const dal = await getDal();
  const prefix = `agent-label-${run}`;
  const slug = `meta/proposals/${prefix}`;
  const { server, tools } = mcpAs('Claude Code');
  try {
    const proposer = await createTestUser('proposer');
    const operator = await createTestUser('operator');
    await createWikiPage(
      dal,
      { slug, title: { en: 'Agent label' }, body: { en: 'Text.' }, canonicalLanguage: 'en', revSummary: { en: 'Create.' } },
      proposer.id
    );
    const position = await signOffPage(dal, { slug, stance: 'support', comment: 'Yes.', commentLanguage: 'en' }, proposer.id);
    const auth = { authInfo: { extra: { userId: operator.id } } };
    const reply = (body: string, reviewedByOperator: boolean) =>
      tools.proposal_replyToPosition.handler(
        { slug, signoffId: position.id, body, bodyLanguage: 'en', reviewedByOperator },
        auth
      );

    const unreviewed = await reply('The change is in section 2.', false);
    assert.equal(unreviewed.isError, undefined, JSON.stringify(unreviewed.structuredContent));
    const unreviewedId = (unreviewed.structuredContent as { commentId: string }).commentId;
    const labelled = await readForumComment(unreviewedId);
    assert.equal(labelled.agentAuthored, true);
    assert.equal(labelled.agentName, 'Claude Code');
    const tags = await dal.query('SELECT _rev_tags FROM forum_comments WHERE id = $1', [unreviewedId]);
    assert.deepEqual((tags.rows[0] as { _rev_tags: string[] })._rev_tags, ['agent:claude-code', 'agent_version:1.2.3', 'create']);

    const reviewed = await reply('Reviewed text.', true);
    const reviewedId = (reviewed.structuredContent as { commentId: string }).commentId;
    assert.equal((await readForumComment(reviewedId)).agentAuthored, false);

    const { threadId } = unreviewed.structuredContent as { threadId: string };
    const web = await createForumComment({ threadId, body: 'From the website.', language: 'en' }, operator.id);
    assert.equal(web.agentAuthored, false);
    assert.equal(web.agentName, null);

    const listed = await tools.proposal_listPositions.handler({ slug });
    const replies = (listed.structuredContent as {
      positions: Array<{ replies: Array<{ id: string; agentAuthored: boolean; agentName: string | null }> }>;
    }).positions[0].replies;
    assert.deepEqual(
      replies.map(item => [item.id, item.agentAuthored, item.agentName]),
      [
        [unreviewedId, true, 'Claude Code'],
        [reviewedId, false, null],
        [web.id, false, null],
      ]
    );
  } finally {
    await server.close();
  }
});

test('Only the operator can remove the label; the history keeps the labelled version', async () => {
  const dal = await getDal();
  const prefix = `agent-label-remove-${run}`;
  const operator = await createTestUser('remover');
  const other = await createTestUser('other');
  const thread = await createForumThread(
    {
      category: 'general',
      title: `${prefix} thread`,
      body: 'Posted by an agent.',
      language: 'en',
      agent: { name: 'claude-ai' },
    },
    operator.id
  );
  const before = await readForumComment(thread.firstCommentId);
  assert.equal(before.agentAuthored, true);

  await assert.rejects(() => removeForumCommentAgentLabel(dal, thread.firstCommentId, other.id), ForbiddenError);
  const after = await removeForumCommentAgentLabel(dal, thread.firstCommentId, operator.id);
  assert.equal(after.agentAuthored, false);
  assert.equal(after.agentName, null);
  assert.equal(after.edited, false, 'Removing the label does not mark the text as edited');
  assert.deepEqual(after.body, before.body);
  assert.deepEqual(after.updatedAt, before.updatedAt);
  assert.equal(await findForumCommentAuthorId(dal, thread.firstCommentId), operator.id);
  assert.deepEqual(
    (await listForumCommentVersions(dal, thread.firstCommentId)).map(version => version.agentAuthored),
    [true, false]
  );
  // Removing it again changes nothing.
  await removeForumCommentAgentLabel(dal, thread.firstCommentId, operator.id);
  assert.equal((await listForumCommentVersions(dal, thread.firstCommentId)).length, 2);
});

test('The label shows beside the operator with an explanation, and its author can remove it', () => {
  const t = i18next.t.bind(i18next);
  assert.equal(renderAgentLabel({ agentAuthored: false, agentName: 'Claude' }, 'Erik', t), '');
  const label = renderAgentLabel({ agentAuthored: true, agentName: 'Claude <x>' }, 'Erik', t);
  assert.match(label, /class="agent-label" data-meta="true" tabindex="0" title="Written and posted by Erik’s agent on its own\. Erik did not read this text before it was posted\.">agent \(Claude &lt;x&gt;\)<\/span>/);
  assert.match(renderAgentLabel({ agentAuthored: true, agentName: null }, 'Erik', t), /^ · <span [^>]*>agent<\/span>$/);

  const html = renderPageSignoffs({
    slug: 'meta/proposals/test',
    currentRevId: 'revision',
    signoffs: [
      { id: 'position', pageId: 'page', revId: 'revision', userId: 'author', stance: 'support', comment: 'Yes.', commentLanguage: 'en', signedAt: new Date() },
    ],
    userMap: new Map([
      ['author', 'Author'],
      ['operator', 'Operator'],
    ]),
    viewerId: 'operator',
    canSignOff: true,
    t,
    language: 'en',
    languageOptions: [{ code: 'en', label: 'English' }],
    replies: new Map([
      [
        'position',
        {
          threadId: 'thread',
          replies: [
            {
              id: 'reply', threadId: 'thread', authorId: 'operator', body: 'Text', bodyLanguage: 'en',
              agentAuthored: true, agentName: 'Claude', createdAt: new Date(), edited: false, bodyHtml: '<p>Text</p>',
            },
          ],
        },
      ],
    ]),
  });
  assert.match(html, /<strong class="discussion-author">Operator<\/strong> · <span class="agent-label"[^>]*>agent \(Claude\)<\/span>/);
  assert.ok(html.includes('action="/tool/forum/comment/reply/agent-label"'));
  assert.ok(html.includes('Remove agent label'));
});
