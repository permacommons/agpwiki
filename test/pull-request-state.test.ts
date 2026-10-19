import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePullRequestUrl, readProposalLinks, readProposalStatus } from '../src/lib/proposal-status.js';
import { createPullRequestStateCache } from '../src/services/pull-request-state.js';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('normalizePullRequestUrl accepts only pull requests on the Agpedia repository', () => {
  assert.equal(
    normalizePullRequestUrl(' https://github.com/permacommons/agpwiki/pull/86/files#diff '),
    'https://github.com/permacommons/agpwiki/pull/86'
  );
  assert.equal(normalizePullRequestUrl('github.com/permacommons/agpwiki/pull/86'), null);
  assert.equal(normalizePullRequestUrl('https://github.com/someone/else/pull/86'), null);
  assert.equal(normalizePullRequestUrl('https://github.com/permacommons/agpwiki/issues/86'), null);
});

test('readProposalLinks reads links with or without a status', () => {
  assert.equal(readProposalLinks(null), null);
  assert.equal(readProposalLinks({ proposal: { status: 'open' } }), null);
  assert.deepEqual(
    readProposalLinks({ proposal: { pullRequests: ['https://github.com/permacommons/agpwiki/pull/1', 3] } }),
    { pullRequests: ['https://github.com/permacommons/agpwiki/pull/1'], parentId: null }
  );
  assert.deepEqual(readProposalLinks({ proposal: { status: 'open', parentId: 'parent-page-id' } }), {
    pullRequests: [],
    parentId: 'parent-page-id',
  });
});

test('readProposalStatus excludes links without changing stored properties', () => {
  const status = {
    status: 'adopted',
    changedAt: '2026-10-19T00:00:00Z',
    changedBy: 'editor-id',
    decidedAt: '2026-10-19T00:00:00Z',
    decidedBy: 'admin-id',
    decisionNote: { en: 'Adopted after review.' },
  };
  const properties = {
    proposal: {
      ...status,
      parentId: 'parent-page-id',
      pullRequests: ['https://github.com/permacommons/agpwiki/pull/1'],
    },
  };
  assert.deepEqual(readProposalStatus(properties), status);
  assert.deepEqual(readProposalLinks(properties), {
    parentId: 'parent-page-id',
    pullRequests: ['https://github.com/permacommons/agpwiki/pull/1'],
  });
  assert.equal(readProposalStatus(null), null);
  assert.equal(readProposalStatus({ proposal: { parentId: 'parent-page-id' } }), null);
});

test('pull request states are read from GitHub and cached', async () => {
  let clock = 0;
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {
    '1': { state: 'closed', merged_at: '2026-10-01T00:00:00Z', title: 'One' },
    '2': { state: 'open', draft: false, title: 'Two' },
    '3': { state: 'open', draft: true, title: 'Three' },
    '4': { state: 'closed', merged_at: null, title: 'Four' },
  };
  const cache = createPullRequestStateCache(
    async url => {
      calls.push(url);
      const number = url.split('/').pop() ?? '';
      return bodies[number] ? jsonResponse(bodies[number]) : jsonResponse({}, 404);
    },
    () => clock
  );
  const urls = [1, 2, 3, 4, 5].map(n => `https://github.com/permacommons/agpwiki/pull/${n}`);

  const states = await cache.getStates(urls);
  assert.deepEqual(
    states.map(pr => [pr.number, pr.state]),
    [
      [1, 'merged'],
      [2, 'open'],
      [3, 'draft'],
      [4, 'closed'],
      [5, 'unknown'],
    ]
  );
  assert.equal(states[0].title, 'One');
  assert.equal(calls.length, 5);
  assert.equal(calls[0], 'https://api.github.com/repos/permacommons/agpwiki/pulls/1');

  await cache.getStates(urls.slice(0, 4));
  assert.equal(calls.length, 5, 'fresh entries come from the cache');

  clock += 11 * 60 * 1000;
  bodies['2'] = { state: 'closed', merged_at: '2026-10-02T00:00:00Z', title: 'Two' };
  const refreshed = await cache.getStates([urls[1]]);
  assert.equal(refreshed[0].state, 'merged');
  assert.equal(calls.length, 6);
});

test('a failing GitHub keeps the last known state and a slow one does not hold up the page', async () => {
  let clock = 0;
  let mode: 'ok' | 'fail' | 'slow' = 'ok';
  const cache = createPullRequestStateCache(
    async () => {
      if (mode === 'fail') throw new Error('network');
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 200));
      return jsonResponse({ state: 'open', title: 'Slow' });
    },
    () => clock
  );
  const url = 'https://github.com/permacommons/agpwiki/pull/9';
  assert.equal((await cache.getStates([url]))[0].state, 'open');

  clock += 11 * 60 * 1000;
  mode = 'fail';
  assert.equal((await cache.getStates([url]))[0].state, 'open');

  cache.clear();
  mode = 'slow';
  const started = Date.now();
  const [info] = await cache.getStates([url], 20);
  assert.equal(info.state, 'unknown');
  assert.ok(Date.now() - started < 150);
});
