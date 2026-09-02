import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMonthRange } from './analytics.mjs';
import { buildObservedAdultAnalytics, buildScheduledAttendanceAnalytics } from './attendance-timeline.mjs';

const range = buildMonthRange('2026-09');
const student = { student_id: '10', student_name: 'Student', class_id: '5', class_name: '5' };
const scheduleRows = [{
  entry_id: '1', week_id: '1', week_version_id: '1', week_start: '2026-08-31', lesson_date: '2026-09-01',
  day_of_week: 2, slot_id: '1', slot_number: 1, start_time: '09:00:00', end_time: '10:00:00',
  class_id: '5', class_name: '5', student_id: null, subject_id: 'math', subject_name: 'Math', slot_part: 'FULL',
}];

test('scheduled analytics counts unmarked time as absence', () => {
  const result = buildScheduledAttendanceAnalytics({
    range, students: [student], scheduleRows, publishedSchoolDays: ['2026-09-01'], now: '2026-09-01 12:00:00',
  });
  assert.equal(result.actual.scheduled_minutes, 60);
  assert.equal(result.actual.attended_minutes, 0);
  assert.equal(result.actual.no_mark_minutes, 60);
  assert.equal(result.actual.attendance_percent, 0);
  assert.equal(result.students[0].days[0].status_code, 'absent');
});

test('partial absence is subtracted from a valid presence interval', () => {
  const result = buildScheduledAttendanceAnalytics({
    range,
    students: [student],
    scheduleRows,
    publishedSchoolDays: ['2026-09-01'],
    now: '2026-09-01 12:00:00',
    presenceEvents: [{ id: '1', student_id: '10', event_type: 'arrival', attendance_date: '2026-09-01', occurred_at: '2026-09-01 08:50:00' }],
    periods: [{ id: '1', student_id: '10', starts_at: '2026-09-01 09:30:00', ends_at: '2026-09-01 10:00:00' }],
  });
  assert.equal(result.actual.attended_minutes, 30);
  assert.equal(result.actual.confirmed_absence_minutes, 30);
  assert.equal(result.students[0].days[0].status_code, 'incomplete');
});

test('unresolved conflict minutes are excluded from the KPI', () => {
  const result = buildScheduledAttendanceAnalytics({
    range,
    students: [student],
    scheduleRows,
    publishedSchoolDays: ['2026-09-01'],
    now: '2026-09-01 12:00:00',
    presenceEvents: [{ id: '1', student_id: '10', event_type: 'arrival', attendance_date: '2026-09-01', occurred_at: '2026-09-01 09:30:00' }],
    periods: [{ id: '1', student_id: '10', starts_at: '2026-09-01 09:00:00', ends_at: '2026-09-01 10:00:00' }],
    conflicts: [{ status: 'open', student_id: '10', presence_event_id: '1', occurred_at: '2026-09-01 09:30:00', ends_at: '2026-09-01 10:00:00' }],
  });
  assert.equal(result.actual.scheduled_minutes, 30);
  assert.equal(result.actual.conflict_minutes, 30);
  assert.equal(result.students[0].days[0].status_code, 'conflict');
});

test('future lessons and planned absences do not affect actual metrics', () => {
  const futureSchedule = [{ ...scheduleRows[0], entry_id: '2', lesson_date: '2026-09-02', day_of_week: 3 }];
  const result = buildScheduledAttendanceAnalytics({
    range,
    students: [student],
    scheduleRows: futureSchedule,
    publishedSchoolDays: ['2026-09-02'],
    now: '2026-09-01 12:00:00',
    periods: [{ id: '2', student_id: '10', starts_at: '2026-09-02 09:00:00', ends_at: '2026-09-02 10:00:00' }],
  });
  assert.equal(result.actual.scheduled_minutes, 0);
  assert.equal(result.planned.absence_minutes, 60);
});

test('weekends without a schedule are not reported as schedule gaps', () => {
  const result = buildScheduledAttendanceAnalytics({
    range: makeRange(['2026-09-05']),
    students: [student],
    scheduleRows: [],
    publishedSchoolDays: [],
    activeWeekdays: [1, 2, 3, 4, 5],
    now: '2026-09-05 18:00:00',
  });

  assert.equal(result.quality.schedule_gap_student_days, 0);
});

test('adult analytics exposes observed time without an invented attendance norm', () => {
  const result = buildObservedAdultAnalytics({
    range: makeRange(['2026-09-01']),
    people: [{ id: '20' }],
    presenceEvents: [
      event('20', '2026-09-01 09:00:00', 'arrival', '101'),
      event('20', '2026-09-01 12:00:00', 'departure', '102'),
    ],
    now: '2026-09-01 18:00:00',
  });

  assert.equal(result.actual.onsite_minutes, 180);
  assert.equal(result.actual.present_days, 1);
  assert.equal(result.actual.attendance_percent, null);
  assert.equal(result.actual.expected_minutes, null);
});

test('scheduled attendance excludes meals and lesson zero', () => {
  const ignoredAndAcademic = [
    { ...scheduleRows[0], entry_id: 'zero', slot_id: 'zero', slot_number: 0, start_time: '08:00:00', end_time: '08:40:00', subject_name: 'Подготовка' },
    { ...scheduleRows[0], entry_id: 'breakfast', slot_id: 'breakfast', start_time: '08:40:00', end_time: '09:00:00', subject_name: 'Завтрак' },
    scheduleRows[0],
    { ...scheduleRows[0], entry_id: 'snack', slot_id: 'snack', slot_number: 2, start_time: '10:00:00', end_time: '10:20:00', subject_name: 'Полдник' },
  ];
  const result = buildScheduledAttendanceAnalytics({
    range,
    students: [student],
    scheduleRows: ignoredAndAcademic,
    publishedSchoolDays: ['2026-09-01'],
    now: '2026-09-01 12:00:00',
  });

  assert.equal(result.actual.scheduled_minutes, 60);
  assert.equal(result.actual.no_mark_minutes, 60);
});

function makeRange(days) {
  return {
    month: '2026-09',
    start_at: `${days[0]} 00:00:00`,
    end_at: `${days.at(-1)} 23:59:59`,
    days,
  };
}

function event(studentId, occurredAt, eventType, id) {
  return {
    id,
    student_id: studentId,
    attendance_date: occurredAt.slice(0, 10),
    occurred_at: occurredAt,
    event_type: eventType,
  };
}
