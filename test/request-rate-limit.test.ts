import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeRateLimit,
  getRateLimitKey,
  resetRateLimitBuckets,
} from '../src/services/request-rate-limit.js';

test.beforeEach(() => {
  resetRateLimitBuckets();
});

test('consumeRateLimit blocks requests after the configured limit within a window', () => {
  const key = '127.0.0.1';
  const start = Date.now();

  for (let i = 0; i < 5; i += 1) {
    const result = consumeRateLimit('signup', key, start);
    assert.equal(result.allowed, true);
  }

  const blocked = consumeRateLimit('signup', key, start);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
});

test('consumeRateLimit resets after the configured window elapses', () => {
  const key = '127.0.0.1';
  const start = Date.now();

  for (let i = 0; i < 5; i += 1) {
    assert.equal(consumeRateLimit('signup', key, start).allowed, true);
  }
  assert.equal(consumeRateLimit('signup', key, start).allowed, false);
  assert.equal(consumeRateLimit('signup', key, start + 15 * 60 * 1000).allowed, true);
});

test('getRateLimitKey uses req.ip when available', () => {
  const req = {
    headers: { 'x-forwarded-for': '198.51.100.10, 203.0.113.77' },
    ip: '203.0.113.77',
    socket: { remoteAddress: '127.0.0.1' },
  };

  assert.equal(getRateLimitKey(req as never, 'signup'), 'signup:203.0.113.77');
});
