import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMonthRange } from './analytics.mjs';
import { buildAnalyticsRange } from './attendance-analytics-contract.mjs';
import {
  MISSED_LESSON_MIN_OVERLAP_MINUTES,
  buildLearningAnalytics,
} from './learning-analytics.mjs';

const range = buildMonthRange('2026-05');
const student = {
  student_id: '10',
  student_name: 'Student',
  class_id: '5',
  class_name: '5',
};

function period(overrides = {}) {
  return {
    id: 'p1',
    student_id: '10',
    student_name: 'Student',
    class_id: '5',
    class_name: '5',
    starts_at: '2026-05-04 09:00:00',
    ends_at: '2026-05-04 09:15:00',
    reason_code: 'illness',
    reason_name: 'Illness',
    comment: '',
    attention_status: 'normal',
    confirmation_status: 'confirmed',
    ...overrides,
  };
}

function schedule(overrides = {}) {
  return {
    entry_id: 'e1',
    week_id: 'w1',
    week_version_id: 'v1',
    week_start: '2026-05-04',
    lesson_date: '2026-05-04',
    day_of_week: 1,
    slot_id: 's1',
    slot_number: 1,
    start_time: '09:00:00',
    end_time: '09:40:00',
    class_id: '5',
    class_name: '5',
    student_id: null,
    subject_id: 'math',
    subject_name: 'Math',
    subject_type: 'Academic',
    teacher_id: 't1',
    teacher_name: 'Teacher',
    room_id: 'r1',
    room_name: '101',
    activity_type: 'default_lesson',
    slot_part: 'FULL',
    is_paid: 0,
    lesson_type_id: '1',
    ...overrides,
  };
}

function assignment(overrides = {}) {
  return schedule({
    assignment_key: 'assignment-1',
    assignment_status: 'assigned',
    assignment_starts_at: '2026-05-04 09:00:00',
    assignment_ends_at: '2026-05-04 09:40:00',
    entry_id: 'old-individual',
    student_id: student.student_id,
    source_scope: 'student',
    release_state: 'full',
    ...overrides,
  });
}

test('saved assignments preserve original subjects and exact half-slot times without counting unconfirmed minutes', () => {
  const fixtureRange = buildAnalyticsRange('2026-05-04', '2026-05-05');
  const english = assignment({
    assignment_key: 'english', source_scope: 'group', group_id: '4', entry_id: 'old-group',
    subject_id: 'english', subject_name: 'English', slot_id: 's2', slot_number: 2, slot_part: 'H2',
    assignment_starts_at: '2026-05-04 10:20:00', assignment_ends_at: '2026-05-04 10:40:00',
  });
  const input = {
    range: fixtureRange, students: [student], includeLessons: true,
    publishedSchoolDays: fixtureRange.days,
    periods: [period({ starts_at: '2026-05-04 08:55:00', ends_at: '2026-05-05 10:15:00' })],
    scheduleRows: [
      schedule({ subject_id: 'literature', subject_name: 'Literature' }),
      schedule({
        entry_id: 'new-group', subject_id: 'french', subject_name: 'French', student_id: student.student_id,
        group_id: '5', source_scope: 'group', slot_id: 's2', slot_number: 2, start_time: '10:00:00', end_time: '10:40:00',
      }),
      schedule({ entry_id: 'biology', lesson_date: '2026-05-05', subject_id: 'biology', subject_name: 'Biology' }),
      schedule({
        entry_id: 'physics', lesson_date: '2026-05-05', subject_id: 'physics', subject_name: 'Physics',
        slot_id: 's2', slot_number: 2, start_time: '10:00:00', end_time: '10:40:00',
      }),
      assignment(), english, english,
    ],
  };
  const planned = buildLearningAnalytics({ ...input, now: '2026-05-03 12:00:00' });
  assert.equal(planned.missed_lessons_total, 0);
  assert.equal(planned.planned_lessons_total, 4);
  const actual = buildLearningAnalytics({ ...input, now: '2026-05-05 12:00:00' });
  assert.equal(actual.confirmed_missed_lessons_total, 3);
  assert.equal(actual.missed_lessons_total, 3);
  assert.deepEqual(actual.confirmed_lessons.map((lesson) => [lesson.subject_name, lesson.confirmed_absence_minutes, lesson.removed_from_schedule]), [
    ['Math', 40, true], ['English', 20, true], ['Biology', 40, false], ['Physics', 15, false],
  ]);
  assert.equal(actual.confirmed_lessons[1].time_label, '10:20-10:40');
  assert.equal(actual.confirmed_lessons[3].counts_as_confirmed_missed_lesson, false);
});

test('new snapshot states suppress a moved or cancelled original without suppressing the replacement slot', () => {
  const fixtureRange = buildAnalyticsRange('2026-05-04', '2026-05-04');
  const input = {
    range: fixtureRange, students: [student], includeLessons: true,
    now: '2026-05-04 12:00:00', publishedSchoolDays: fixtureRange.days,
    periods: [period({ ends_at: '2026-05-04 10:45:00' })],
    scheduleRows: [
      schedule({ subject_id: 'literature', subject_name: 'Literature' }),
      assignment({ assignment_updated_at: '2026-05-01 09:00:00' }),
      assignment({ assignment_updated_at: '2026-05-02 09:00:00', assignment_status: 'moved' }),
      assignment({
        assignment_key: 'moved-math', entry_id: 'new-individual', slot_id: 's2', slot_number: 2,
        assignment_starts_at: '2026-05-04 10:00:00', assignment_ends_at: '2026-05-04 10:40:00',
      }),
    ],
  };
  const moved = buildLearningAnalytics(input);
  assert.equal(moved.confirmed_missed_lessons_total, 1);
  assert.deepEqual(moved.lessons.map((lesson) => lesson.time_label), ['10:00-10:40']);

  const cancelled = buildLearningAnalytics({ ...input, scheduleRows: [
    input.scheduleRows[0], input.scheduleRows[1], { ...input.scheduleRows[2], assignment_status: 'cancelled' },
  ] });
  assert.equal(cancelled.missed_lessons_total, 0);
  assert.equal(cancelled.data_gaps_total, 0);
});

test('historical absences with no saved assignment are reported as incomplete and keep the original absence', () => {
  const fixtureRange = buildAnalyticsRange('2026-05-04', '2026-05-04');
  const result = buildLearningAnalytics({
    range: fixtureRange, students: [student], includeLessons: true,
    scheduleCoverageFrom: '2026-05-05', now: '2026-05-04 12:00:00', publishedSchoolDays: fixtureRange.days,
    periods: [period({ ends_at: '2026-05-04 09:40:00' })], scheduleRows: [schedule()],
  });
  assert.deepEqual(result.lessons, []);
  assert.equal(result.confirmed_missed_lessons_total, 0);
  assert.equal(result.uncovered_absence_periods, 1);
  assert.equal(result.data_gaps[0].absence_id, 'p1');
  assert.equal(result.data_gaps[0].code, 'unverified_historical_schedule');
  assert.deepEqual(result.historical_schedule_gap_dates.map((row) => row.date), ['2026-05-04']);
});

test('only explicit saved weekend assignments enter the Saturday lesson calculation', () => {
  const fixtureRange = buildAnalyticsRange('2026-05-09', '2026-05-10');
  const raw = schedule({ entry_id: 'live-saturday', lesson_date: '2026-05-09', subject_name: 'Live subject' });
  const saved = assignment({
    lesson_date: '2026-05-09', assignment_starts_at: '2026-05-09 09:00:00',
    assignment_ends_at: '2026-05-09 09:40:00', release_state: 'partial',
  });
  const input = {
    range: fixtureRange, students: [student], includeLessons: true,
    periods: [period({ starts_at: '2026-05-09 09:00:00', ends_at: '2026-05-09 09:15:00' })],
    scheduleRows: [raw, saved],
  };
  const planned = buildLearningAnalytics({ ...input, now: '2026-05-08 12:00:00' });
  assert.equal(planned.confirmed_missed_lessons_total, 0);
  assert.equal(planned.planned_lessons_total, 1);
  assert.equal(planned.planned_lessons[0].overlap_minutes, 15);

  const actual = buildLearningAnalytics({ ...input, now: '2026-05-10 12:00:00' });
  assert.equal(actual.covered_absence_periods, 1);
  assert.equal(actual.confirmed_missed_lessons_total, 0);
  assert.equal(actual.data_gaps_total, 0);
  assert.deepEqual(actual.confirmed_lessons.map((lesson) => [lesson.subject_name, lesson.confirmed_absence_minutes]), [['Math', 15]]);

  const baseline = buildLearningAnalytics({ ...input, scheduleRows: [raw], now: '2026-05-10 12:00:00' });
  assert.deepEqual(baseline.confirmed_lessons, []);
  assert.equal(baseline.data_gaps_total, 0);
});

test('lesson is missed only when overlap is strictly greater than threshold', () => {
  const exact = buildLearningAnalytics({
    range,
    students: [student],
    periods: [period()],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
  });
  assert.equal(exact.missed_lessons_total, 0);
  assert.equal(MISSED_LESSON_MIN_OVERLAP_MINUTES, 15);

  const above = buildLearningAnalytics({
    range,
    students: [student],
    periods: [period({ ends_at: '2026-05-04 09:16:00' })],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
  });
  assert.equal(above.missed_lessons_total, 1);
});

test('multi-day absence is clipped to selected month', () => {
  const analytics = buildLearningAnalytics({
    range,
    students: [student],
    periods: [period({
      starts_at: '2026-04-30 09:00:00',
      ends_at: '2026-05-02 10:00:00',
    })],
    scheduleRows: [schedule({ lesson_date: '2026-05-01', day_of_week: 5 })],
    publishedSchoolDays: ['2026-05-01'],
  });

  assert.equal(analytics.missed_lessons_total, 1);
  assert.equal(analytics.lessons, undefined);
  assert.equal(analytics.daily.find((row) => row.date === '2026-05-01').missed_lessons, 1);
});

test('open absence is clipped to report end', () => {
  const analytics = buildLearningAnalytics({
    range,
    students: [student],
    periods: [period({
      starts_at: '2026-05-29 09:00:00',
      ends_at: null,
    })],
    scheduleRows: [schedule({ lesson_date: '2026-05-29', day_of_week: 5 })],
    publishedSchoolDays: ['2026-05-29'],
  });

  assert.equal(analytics.missed_lessons_total, 1);
  assert.equal(analytics.uncovered_absence_periods, 0);
});

test('H1 and H2 schedule parts use effective half-slot bounds', () => {
  const analytics = buildLearningAnalytics({
    range,
    students: [student],
    periods: [period({
      starts_at: '2026-05-04 09:21:00',
      ends_at: '2026-05-04 09:40:00',
    })],
    scheduleRows: [
      schedule({ entry_id: 'h1', subject_id: 'math', subject_name: 'Math', slot_part: 'H1' }),
      schedule({ entry_id: 'h2', subject_id: 'eng', subject_name: 'English', slot_part: 'H2' }),
    ],
    publishedSchoolDays: ['2026-05-04'],
    includeLessons: true,
  });

  assert.equal(analytics.missed_lessons_total, 1);
  assert.equal(analytics.lessons[0].subject_name, 'English');
  assert.equal(analytics.lessons[0].time_label, '09:20-09:40');
});

test('individual schedule replaces class lesson in the same slot', () => {
  const analytics = buildLearningAnalytics({
    range,
    students: [student],
    periods: [period({ ends_at: '2026-05-04 09:40:00' })],
    scheduleRows: [
      schedule({ entry_id: 'class', subject_id: 'math', subject_name: 'Math' }),
      schedule({ entry_id: 'student', student_id: '10', subject_id: 'eng', subject_name: 'English' }),
    ],
    publishedSchoolDays: ['2026-05-04'],
    includeLessons: true,
  });

  assert.equal(analytics.missed_lessons_total, 1);
  assert.equal(analytics.lessons[0].subject_name, 'English');
  assert.equal(analytics.subjects.length, 1);
});

test('absence without published schedule creates data gap and no missed lessons', () => {
  const analytics = buildLearningAnalytics({
    range,
    students: [student],
    periods: [period({ ends_at: '2026-05-04 09:40:00' })],
    scheduleRows: [],
    publishedSchoolDays: [],
  });

  assert.equal(analytics.missed_lessons_total, 0);
  assert.equal(analytics.uncovered_absence_periods, 1);
  assert.equal(analytics.coverage_percent, 0);
  assert.equal(analytics.data_gaps.length, 1);
  assert.equal(analytics.data_gaps[0].code, 'no_published_schedule');
});
