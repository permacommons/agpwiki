import assert from 'node:assert/strict';
import test from 'node:test';

import { forgetInRequest, memoizeInRequest, runInRequestScope } from '../src/lib/request-scope.js';

test('memoizeInRequest computes once per request and never outside one', async () => {
  let calls = 0;
  const compute = async () => ++calls;

  assert.equal(await memoizeInRequest('k', compute), 1);
  assert.equal(await memoizeInRequest('k', compute), 2);

  await runInRequestScope(async () => {
    assert.equal(await memoizeInRequest('k', compute), 3);
    assert.equal(await memoizeInRequest('k', compute), 3);
    forgetInRequest('k');
    assert.equal(await memoizeInRequest('k', compute), 4);
  });

  await runInRequestScope(async () => {
    assert.equal(await memoizeInRequest('k', compute), 5);
  });
});
