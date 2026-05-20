import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMonthRange,
  compareClassNames,
  expandDateRangeWithinMonth,
  normalizeAnalyticsMonth,
} from './analytics.mjs';

test('normalizeAnalyticsMonth accepts strict YYYY-MM values', () => {
  assert.equal(normalizeAnalyticsMonth('2026-05'), '2026-05');
  assert.equal(normalizeAnalyticsMonth('2026-12'), '2026-12');
});

test('normalizeAnalyticsMonth falls back to current month for invalid values', () => {
  const now = new Date(2026, 4, 20);
  assert.equal(normalizeAnalyticsMonth('2026-13', now), '2026-05');
  assert.equal(normalizeAnalyticsMonth('2026-5', now), '2026-05');
  assert.equal(normalizeAnalyticsMonth('', now), '2026-05');
});

test('buildMonthRange returns stable local month boundaries', () => {
  const range = buildMonthRange('2026-05');
  assert.equal(range.start_at, '2026-05-01 00:00:00');
  assert.equal(range.end_at, '2026-05-31 23:59:59');
  assert.equal(range.days_count, 31);
  assert.equal(range.days[0], '2026-05-01');
  assert.equal(range.days.at(-1), '2026-05-31');
});

test('expandDateRangeWithinMonth clamps periods to selected month', () => {
  const range = buildMonthRange('2026-05');
  assert.deepEqual(
    expandDateRangeWithinMonth('2026-04-30 08:00:00', '2026-05-02 12:00:00', range),
    ['2026-05-01', '2026-05-02'],
  );
});

test('expandDateRangeWithinMonth counts open periods as start day only', () => {
  const range = buildMonthRange('2026-05');
  assert.deepEqual(
    expandDateRangeWithinMonth('2026-05-10 08:00:00', null, range),
    ['2026-05-10'],
  );
});

test('compareClassNames sorts classes in natural school order', () => {
  const classes = ['5-2', '1', '10', '11', '2', '5-1', '8-АРТ', '8-2', 'ДШК'];
  assert.deepEqual(
    classes.toSorted(compareClassNames),
    ['1', '2', '5-1', '5-2', '8-2', '8-АРТ', '10', '11', 'ДШК'],
  );
});
