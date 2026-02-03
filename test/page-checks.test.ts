import assert from 'node:assert/strict';
import test from 'node:test';

import { getPageCheckMetricsErrors } from '../src/lib/page-checks.js';

test('getPageCheckMetricsErrors accepts valid metrics', () => {
  const errors = getPageCheckMetricsErrors({
    issues_found: { high: 2, medium: 1, low: 0 },
    issues_fixed: { high: 1, medium: 1, low: 0 },
  });
  assert.deepEqual(errors, []);
});

test('getPageCheckMetricsErrors reports missing and range errors', () => {
  const errors = getPageCheckMetricsErrors({
    issues_found: { high: 1, medium: 0, low: 0 },
    issues_fixed: { high: 2, medium: 0, low: 0 },
  });
  assert.ok(errors.some(error => error.field === 'metrics.issues_fixed.high'));
});

test('getPageCheckMetricsErrors reports type problems', () => {
  const errors = getPageCheckMetricsErrors({
    issues_found: { high: 1, medium: 0, low: 0 },
  });
  assert.ok(errors.some(error => error.field === 'metrics.issues_fixed'));
});
