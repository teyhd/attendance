import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMonthRange } from './analytics.mjs';
import {
  LATE_MISSED_LESSON_MIN_OVERLAP_MINUTES,
  LATE_THRESHOLD_MINUTES,
  buildLateAnalytics,
} from './late-analytics.mjs';

const range = buildMonthRange('2026-05');
const student = {
  student_id: '10',
  student_name: 'Student',
  class_id: '5',
  class_name: '5',
};

function arrival(overrides = {}) {
  return {
    id: 'a1',
    student_id: '10',
    student_name: 'Student',
    class_id: '5',
    class_name: '5',
    event_type: 'arrival',
    attendance_date: '2026-05-04',
    arrival_at: '2026-05-04 09:06:00',
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

test('arrival is late only after five full minutes', () => {
  assert.equal(LATE_THRESHOLD_MINUTES, 5);
  const exact = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [arrival({ arrival_at: '2026-05-04 09:05:00' })],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
  });
  assert.equal(exact.late_days_total, 0);

  const above = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [arrival({ arrival_at: '2026-05-04 09:06:00' })],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
  });
  assert.equal(above.late_days_total, 1);
  assert.equal(above.students[0].late_days, 1);
});

test('late missed lesson uses strict fifteen minute overlap', () => {
  assert.equal(LATE_MISSED_LESSON_MIN_OVERLAP_MINUTES, 15);
  const exact = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [arrival({ arrival_at: '2026-05-04 09:15:00' })],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
    includeEvents: true,
  });
  assert.equal(exact.late_days_total, 1);
  assert.equal(exact.missed_lessons_total, 0);

  const above = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [arrival({ arrival_at: '2026-05-04 09:16:00' })],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
    includeEvents: true,
  });
  assert.equal(above.missed_lessons_total, 1);
  assert.equal(above.events[0].missed_subject_names, 'Math');
});

test('only the first arrival of the day is used', () => {
  const analytics = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [
      arrival({ id: 'first', arrival_at: '2026-05-04 09:03:00' }),
      arrival({ id: 'second', arrival_at: '2026-05-04 09:30:00' }),
    ],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
  });

  assert.equal(analytics.coverage.arrival_days_total, 1);
  assert.equal(analytics.late_days_total, 0);
});

test('lateness groups late, on-time, and schedule-gap arrivals by class', () => {
  const analytics = buildLateAnalytics({
    range,
    students: [
      student,
      { ...student, student_id: '11', student_name: 'On time' },
      { ...student, student_id: '12', student_name: 'Gap' },
    ],
    arrivals: [
      arrival({ id: 'late', student_id: '10', arrival_at: '2026-05-04 09:10:00' }),
      arrival({ id: 'ontime', student_id: '11', student_name: 'On time', arrival_at: '2026-05-04 09:01:00' }),
      arrival({ id: 'gap', student_id: '12', student_name: 'Gap', attendance_date: '2026-05-05', arrival_at: '2026-05-05 09:01:00' }),
    ],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
  });

  const statuses = new Map(analytics.students.map((row) => [row.student_id, row.status_code]));
  assert.equal(statuses.get('10'), 'late');
  assert.equal(statuses.get('11'), 'arrived');
  assert.equal(statuses.get('12'), 'gap');
  assert.equal(analytics.classes.length, 1);
  assert.equal(analytics.classes[0].students_total, 3);
  assert.equal(analytics.classes[0].students_late, 1);
  assert.equal(analytics.classes[0].students_arrived, 1);
  assert.equal(analytics.classes[0].students_gap, 1);
});

test('individual schedule replaces class lesson in the same slot', () => {
  const analytics = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [arrival({ arrival_at: '2026-05-04 09:20:00' })],
    scheduleRows: [
      schedule({ entry_id: 'class', subject_id: 'math', subject_name: 'Math' }),
      schedule({ entry_id: 'student', student_id: '10', subject_id: 'eng', subject_name: 'English' }),
    ],
    publishedSchoolDays: ['2026-05-04'],
    includeEvents: true,
  });

  assert.equal(analytics.missed_lessons_total, 1);
  assert.equal(analytics.events[0].missed_subject_names, 'English');
  assert.equal(analytics.subjects.length, 1);
});

test('H1 and H2 schedule parts use effective half-slot bounds', () => {
  const analytics = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [arrival({ arrival_at: '2026-05-04 09:36:00' })],
    scheduleRows: [
      schedule({ entry_id: 'h1', subject_id: 'math', subject_name: 'Math', slot_part: 'H1' }),
      schedule({ entry_id: 'h2', subject_id: 'eng', subject_name: 'English', slot_part: 'H2' }),
    ],
    publishedSchoolDays: ['2026-05-04'],
    includeEvents: true,
  });

  assert.equal(analytics.missed_lessons_total, 2);
  assert.deepEqual(
    analytics.events[0].missed_lessons_list.map((lesson) => lesson.time_label),
    ['09:00-09:20', '09:20-09:40'],
  );
});

test('arrival without published schedule creates data gap and no false lateness', () => {
  const analytics = buildLateAnalytics({
    range,
    students: [student],
    arrivals: [arrival({ arrival_at: '2026-05-04 10:00:00' })],
    scheduleRows: [],
    publishedSchoolDays: [],
  });

  assert.equal(analytics.late_days_total, 0);
  assert.equal(analytics.data_gaps_total, 1);
  assert.equal(analytics.coverage.coverage_percent, 0);
  assert.equal(analytics.data_gaps[0].code, 'no_published_schedule');
});
