import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMonthRange } from './analytics.mjs';
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
