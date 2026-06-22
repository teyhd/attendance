import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClassPresenceSummary,
  buildMonthRange,
  compareClassNames,
  countActualPresenceDays,
  expectedPresenceDates,
  expandDateRangeWithinMonth,
  hoursWithinRange,
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

test('hoursWithinRange counts period hours clipped to selected month', () => {
  const range = buildMonthRange('2026-05');
  assert.equal(
    hoursWithinRange('2026-05-10 08:00:00', '2026-05-10 12:30:00', range),
    4.5,
  );
  assert.equal(
    hoursWithinRange('2026-04-30 18:00:00', '2026-05-01 12:00:00', range),
    12,
  );
  assert.equal(Math.round(hoursWithinRange('2026-05-10 08:00:00', null, range) * 10) / 10, 16);
});

test('countActualPresenceDays counts unique non-cancelled arrival days only', () => {
  assert.equal(countActualPresenceDays([
    { student_id: '10', event_type: 'arrival', attendance_date: '2026-05-04' },
    { student_id: '10', event_type: 'arrival', attendance_date: '2026-05-04' },
    { student_id: '10', event_type: 'departure', attendance_date: '2026-05-04' },
    { student_id: '10', event_type: 'arrival', attendance_date: '2026-05-05', cancelled_at: '2026-05-05 10:00:00' },
    { student_id: '11', event_type: 'arrival', occurred_at: '2026-05-04 09:01:00' },
  ]), 2);
});

test('expectedPresenceDates uses published days before weekday fallback', () => {
  const range = buildMonthRange('2026-05');
  assert.deepEqual(
    expectedPresenceDates(range, { publishedSchoolDays: ['2026-05-03', '2026-05-04'], activeWeekdays: [1] }),
    ['2026-05-03', '2026-05-04'],
  );
  assert.deepEqual(
    expectedPresenceDates(range, { publishedSchoolDays: [], activeWeekdays: [1] }).slice(0, 2),
    ['2026-05-04', '2026-05-11'],
  );
});

test('buildClassPresenceSummary keeps factual presence separate from excused absences', () => {
  const range = buildMonthRange('2026-05');
  const summary = buildClassPresenceSummary({
    range,
    studentsTotal: 2,
    arrivals: [
      { student_id: '10', event_type: 'arrival', attendance_date: '2026-05-04' },
      { student_id: '11', event_type: 'arrival', attendance_date: '2026-05-04' },
    ],
    lateness: {
      late_days_total: 1,
      data_gaps_total: 1,
      coverage: { covered_arrival_days: 1 },
    },
    todayAbsences: { totals: { absent_students_today: 1 } },
    publishedSchoolDays: ['2026-05-04', '2026-05-05'],
    absenceDays: 3,
    needsAttention: 1,
    needsClarification: 2,
    withoutReason: 1,
    riskStudentsTotal: 5,
  });

  assert.equal(summary.presence_days, 2);
  assert.equal(summary.expected_presence_days, 4);
  assert.equal(summary.attendance_percent, 50);
  assert.equal(summary.on_time_days, 0);
  assert.equal(summary.absent_today, 1);
  assert.equal(summary.absence_days, 3);
  assert.equal(summary.risk_students_total, 5);
});
