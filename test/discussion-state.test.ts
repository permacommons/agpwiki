import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginDiscussionLoad,
  createDiscussionState,
  discussionControls,
  discussionReadingUrl,
  finishDiscussionLoad,
  readDiscussionSnapshot,
} from '../public/scripts/discussion-state.js';

const threadOrder = Array.from({ length: 41 }, (_, index) => `thread-${index + 1}`);
const createState = (page = 1) => createDiscussionState({ threadOrder, page, pageSize: 20 });
const load = (state: ReturnType<typeof createState>, direction: string) => {
  const requested = beginDiscussionLoad(state, direction);
  assert.ok(requested);
  return finishDiscussionLoad(requested, true);
};
const snapshotOf = (state: ReturnType<typeof createState>) => ({ ...state, html: '<section>Saved discussion</section>' });

test('Loading older threads visits the captured order once, including the short final batch', () => {
  let state = createState();
  const seen = state.threadOrder.slice(state.loadedStart, state.loadedEnd);
  while (true) {
    const requested = beginDiscussionLoad(state, 'older');
    if (!requested) break;
    seen.push(...requested.pending.threadIds);
    state = finishDiscussionLoad(requested, true);
  }
  assert.deepEqual(seen, threadOrder);
  assert.equal(new Set(seen).size, 41);
  assert.equal(state.loadedEnd, 41);
  assert.equal(discussionControls(state).older.showBoundary, true);
  assert.equal(discussionControls(state).showAutomatic, false);
});

test('A middle page can load newer and older batches without gaps or overlap', () => {
  let state = createState(2);
  const newer = beginDiscussionLoad(state, 'newer');
  assert.deepEqual(newer.pending.threadIds, threadOrder.slice(0, 20));
  state = finishDiscussionLoad(newer, true);
  const older = beginDiscussionLoad(state, 'older');
  assert.deepEqual(older.pending.threadIds, [threadOrder[40]]);
  state = finishDiscussionLoad(older, true);
  assert.equal(state.loadedStart, 0);
  assert.equal(state.loadedEnd, 41);
  assert.equal(beginDiscussionLoad(state, 'newer'), null);
  assert.equal(beginDiscussionLoad(state, 'older'), null);
});

test('Loading newer from the last page stops at each preceding batch', () => {
  let state = createState(3);
  const first = beginDiscussionLoad(state, 'newer');
  assert.deepEqual(first.pending.threadIds, threadOrder.slice(20, 40));
  state = finishDiscussionLoad(first, true);
  assert.deepEqual([state.loadedStart, state.loadedEnd], [20, 41]);
  assert.equal(discussionControls(state).newer.showBoundary, false);
  state = load(state, 'newer');
  assert.deepEqual([state.loadedStart, state.loadedEnd], [0, 41]);
  assert.equal(discussionControls(state).newer.showBoundary, true);
});

test('A fresh visit to the beginning omits the newer boundary message', () => {
  const initial = createState();
  assert.equal(discussionControls(initial).newer.showBoundary, false);
  assert.equal(discussionControls(initial).newer.exhausted, true);
  assert.equal(beginDiscussionLoad(initial, 'newer'), null);
  assert.equal(initial.loadedNewer, false);
});

test('An empty discussion has no load actions and reports a zero range', () => {
  const state = createDiscussionState({ threadOrder: [], pageSize: 20 });
  const controls = discussionControls(state);
  assert.deepEqual([controls.rangeStart, controls.rangeEnd, controls.total], [0, 0, 0]);
  assert.equal(controls.showAutomatic, false);
  assert.equal(beginDiscussionLoad(state, 'newer'), null);
  assert.equal(beginDiscussionLoad(state, 'older'), null);
});

test('A pending request blocks overlapping loads in either direction', () => {
  const initial = createState(2);
  const requested = beginDiscussionLoad(initial, 'newer');
  assert.equal(requested.status, 'loading');
  assert.equal(discussionControls(requested).newer.busy, true);
  assert.equal(discussionControls(requested).older.busy, true);
  assert.equal(beginDiscussionLoad(requested, 'newer'), null);
  assert.equal(beginDiscussionLoad(requested, 'older'), null);
  assert.equal(initial.pending, null);
  assert.equal(initial.status, 'idle');
});

test('A failed request preserves the range and retries the same batch with automatic loading off', () => {
  const initial = createState(2);
  const requested = beginDiscussionLoad(initial, 'newer');
  const failed = finishDiscussionLoad(requested, false);
  assert.deepEqual([failed.loadedStart, failed.loadedEnd], [20, 40]);
  assert.equal(failed.status, 'error');
  assert.equal(failed.loadedNewer, false);
  assert.equal(failed.automatic, false);
  assert.equal(discussionControls(failed).newer.busy, false);
  const retry = beginDiscussionLoad(failed, 'newer');
  assert.deepEqual(retry.pending.threadIds, requested.pending.threadIds);
  const completed = finishDiscussionLoad(retry, true);
  assert.equal(completed.status, 'idle');
  assert.equal(completed.automatic, false);
  assert.equal(completed.loadedStart, 0);
});

test('Completing a request preserves an automatic-loading preference changed while waiting', () => {
  const requested = beginDiscussionLoad(createState(), 'older');
  const completed = finishDiscussionLoad({ ...requested, automatic: false }, true);
  assert.equal(completed.automatic, false);
  assert.equal(completed.loadedEnd, 40);
});

test('Changing the source list after opening a discussion cannot change the browsing order', () => {
  const source = [...threadOrder];
  const state = createDiscussionState({ threadOrder: source, pageSize: 20 });
  source.reverse();
  source.unshift('newly-active-thread');
  const requested = beginDiscussionLoad(state, 'older');
  assert.deepEqual(requested.pending.threadIds, threadOrder.slice(20, 40));
});

test('A saved middle range restores navigation and preferences without restoring an in-flight request', () => {
  const pending = beginDiscussionLoad(load(createState(3), 'newer'), 'newer');
  const serialized = JSON.stringify(snapshotOf({ ...pending, automatic: false }));
  const snapshot = readDiscussionSnapshot(serialized, 20);
  assert.ok(snapshot);
  const restored = createDiscussionState({ threadOrder: ['changed-live-order'], pageSize: 20 }, snapshot);
  assert.deepEqual(restored.threadOrder, threadOrder);
  assert.deepEqual([restored.loadedStart, restored.loadedEnd], [20, 41]);
  assert.equal(restored.automatic, false);
  assert.equal(restored.loadedNewer, true);
  assert.equal(restored.pending, null);
  assert.equal(restored.status, 'idle');
  assert.deepEqual(beginDiscussionLoad(restored, 'newer').pending.threadIds, threadOrder.slice(0, 20));
});

test('Invalid or incompatible saved data falls back instead of restoring corrupt state', () => {
  const valid = snapshotOf(createState(2));
  const invalid = [
    null, 'not json', '{}', 'null',
    JSON.stringify({ ...valid, pageSize: 10 }),
    JSON.stringify({ ...valid, threadOrder: null }),
    JSON.stringify({ ...valid, threadOrder: [null] }),
    JSON.stringify({ ...valid, threadOrder: ['same', 'same'] }),
    JSON.stringify({ ...valid, loadedStart: -1 }),
    JSON.stringify({ ...valid, loadedStart: 40, loadedEnd: 20 }),
    JSON.stringify({ ...valid, loadedEnd: 42 }),
    JSON.stringify({ ...valid, loadedEnd: 20.5 }),
    JSON.stringify({ ...valid, automatic: 'false' }),
    JSON.stringify({ ...valid, loadedNewer: null }),
    JSON.stringify({ ...valid, html: null }),
  ];
  for (const serialized of invalid) assert.equal(readDiscussionSnapshot(serialized, 20), null, String(serialized));
});

test('Reading URLs select the visible thread with one ID and a fixed fragment', () => {
  const url = discussionReadingUrl('/example/discussion?thread=abc#thread', 'https://example.test/example/discussion?page=2', false);
  assert.equal(url.href, 'https://example.test/example/discussion?thread=abc#thread');
  assert.equal(url.href.split('abc').length - 1, 1);
});

test('A visible comment retains its fragment until the reader moves to another thread', () => {
  const current = 'https://example.test/example/discussion?thread=abc#comment-def';
  assert.equal(discussionReadingUrl('/example/discussion?thread=abc#thread', current, true).hash, '#comment-def');
  const moved = discussionReadingUrl('/example/discussion?thread=xyz#thread', current, false);
  assert.equal(moved.search, '?thread=xyz');
  assert.equal(moved.hash, '#thread');
});
