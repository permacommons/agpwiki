import assert from 'node:assert/strict';
import test from 'node:test';
import { createWikimediaRequestService } from '../src/services/wikimedia-request-service.js';

const api = 'https://www.wikidata.org/w/api.php?action=wbgetentities';
const sparql = 'https://query.wikidata.org/sparql?query=test';

const fixture = (responses: Response[]) => {
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const calls: Array<{ url: URL; at: number }> = [];
  const request = createWikimediaRequestService({
    now: () => clock,
    wait: async ms => { clock += ms; },
    fetchImpl: async input => {
      calls.push({ url: new URL(String(input)), at: clock });
      return responses.shift() ?? Response.json({});
    },
  });
  return { request, calls, advance: (ms: number) => { clock += ms; } };
};

test('Wikimedia requests share serial pacing across endpoints and add maxlag to Action APIs only', async () => {
  const { request, calls } = fixture([]);
  await Promise.all([request(api), request(sparql), request('https://commons.wikimedia.org/w/api.php')]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.at - calls[0].at), [0, 1000, 2000]);
  assert.equal(calls[0].url.searchParams.get('maxlag'), '5');
  assert.equal(calls[1].url.searchParams.has('maxlag'), false);
  assert.equal(calls[2].url.searchParams.get('maxlag'), '5');
});

test('HTTP throttling honors Retry-After and blocks other items on the same endpoint', async () => {
  const { request, calls, advance } = fixture([
    new Response('Too many requests', { status: 429, headers: { 'Retry-After': '120' } }),
  ]);
  await assert.rejects(request(api), /429/);
  await assert.rejects(request(`${api}&ids=Q2`), /backoff/);
  assert.equal(calls.length, 1);
  await request(sparql);
  advance(118_999);
  await assert.rejects(request(api), /backoff/);
  advance(1);
  await request(api);
  assert.equal(calls.length, 3);
});

test('HTTP-date Retry-After is honored even for non-JSON service errors', async () => {
  const { request, calls, advance } = fixture([
    new Response('Unavailable', { status: 503, headers: { 'Retry-After': 'Sun, 01 Nov 2026 00:02:00 GMT' } }),
  ]);
  await assert.rejects(request(api), /503/);
  advance(119_999);
  await assert.rejects(request(api), /backoff/);
  advance(1);
  await request(api);
  assert.equal(calls.length, 2);
});

test('HTTP 200 API errors fail, with exponential endpoint backoff that resets on success', async () => {
  const { request, calls, advance } = fixture([
    Response.json({ error: { code: 'maxlag', info: 'Waiting for replicas' } }),
    Response.json({ error: { code: 'ratelimited' } }),
    Response.json({}),
    Response.json({ error: { code: 'maxlag' } }),
  ]);
  await assert.rejects(request(api), /maxlag/);
  advance(4999);
  await assert.rejects(request(api), /backoff/);
  advance(1);
  await assert.rejects(request(api), /ratelimited/);
  advance(9999);
  await assert.rejects(request(api), /backoff/);
  advance(1);
  await request(api);
  await assert.rejects(request(api), /maxlag/);
  advance(5000);
  await request(api);
  assert.equal(calls.length, 5);
});

test('A response body finishes before another request starts', async () => {
  let finish!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const request = createWikimediaRequestService({
    intervalMs: 0,
    fetchImpl: async () => {
      calls++;
      if (calls > 1) return Response.json({});
      started();
      return new Response(new ReadableStream({
        start(controller) {
          finish = () => { controller.enqueue(new TextEncoder().encode('{}')); controller.close(); };
        },
      }));
    },
  });
  const first = request(api);
  const second = request(sparql);
  await firstStarted;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});
