import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMonthRange } from './analytics.mjs';
import { buildStudentAttendanceAnalytics } from './student-attendance-analytics.mjs';

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
    starts_at: '2026-05-06 09:00:00',
    ends_at: '2026-05-06 18:00:00',
    reason_code: 'illness',
    reason_name: 'Болезнь',
    is_excused: 1,
    comment: '',
    ...overrides,
  };
}

function arrival(overrides = {}) {
  return {
    id: 'a1',
    student_id: '10',
    class_id: '5',
    event_type: 'arrival',
    attendance_date: '2026-05-04',
    arrival_at: '2026-05-04 08:55:00',
    occurred_at: '2026-05-04 08:55:00',
    ...overrides,
  };
}

function presenceEvent(overrides = {}) {
  return {
    id: 'e1',
    student_id: '10',
    class_id: '5',
    event_type: 'arrival',
    attendance_date: '2026-05-04',
    occurred_at: '2026-05-04 08:55:00',
    ...overrides,
  };
}

function schedule(overrides = {}) {
  return {
    entry_id: 's1',
    week_id: 'w1',
    week_version_id: 'v1',
    week_start: '2026-05-04',
    lesson_date: '2026-05-04',
    day_of_week: 1,
    slot_id: 'slot1',
    slot_number: 1,
    start_time: '09:00:00',
    end_time: '09:40:00',
    class_id: '5',
    class_name: '5',
    student_id: null,
    subject_id: 'math',
    subject_name: 'Math',
    slot_part: 'FULL',
    ...overrides,
  };
}

test('student attendance summary counts presence, absence reasons, and incomplete days', () => {
  const analytics = buildStudentAttendanceAnalytics({
    range,
    students: [student],
    periods: [
      period({
        id: 'partial',
        starts_at: '2026-05-05 10:00:00',
        ends_at: '2026-05-05 10:40:00',
        reason_name: 'Семейные обстоятельства',
        comment: 'заявление',
      }),
      period(),
      period({
        id: 'without',
        starts_at: '2026-05-07 09:00:00',
        ends_at: '2026-05-07 18:00:00',
        reason_code: 'without_reason',
        reason_name: 'Без причины',
        is_excused: 0,
      }),
    ],
    arrivals: [
      arrival(),
      arrival({ id: 'a2', attendance_date: '2026-05-05', arrival_at: '2026-05-05 08:55:00', occurred_at: '2026-05-05 08:55:00' }),
    ],
    presenceEvents: [
      presenceEvent(),
      presenceEvent({ id: 'e2', attendance_date: '2026-05-05', occurred_at: '2026-05-05 08:55:00' }),
    ],
    scheduleRows: [
      schedule(),
      schedule({ entry_id: 's2', lesson_date: '2026-05-05', day_of_week: 2, start_time: '10:00:00', end_time: '10:40:00' }),
      schedule({ entry_id: 's3', lesson_date: '2026-05-06', day_of_week: 3 }),
      schedule({ entry_id: 's4', lesson_date: '2026-05-07', day_of_week: 4 }),
    ],
    publishedSchoolDays: ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07'],
  });

  const row = analytics.students[0];
  assert.equal(row.present_days, 2);
  assert.equal(row.absence_days, 3);
  assert.equal(row.excused_absence_days, 2);
  assert.equal(row.unexcused_absence_days, 1);
  assert.equal(row.incomplete_days, 1);
  assert.equal(row.absence_button_label, 'Отсутствовал: 3 дня');
  assert.equal(row.metric_label, '2/4 присутствовал · 2 уважительно · 1 без причины · 1 неполный день');
  assert.equal(row.days.find((day) => day.date === '2026-05-05').status_code, 'incomplete');
  assert.equal(row.absence_details.find((day) => day.date === '2026-05-07').absence_state_label, 'без причины');
});

test('departure before the last lesson makes a present day incomplete', () => {
  const analytics = buildStudentAttendanceAnalytics({
    range,
    students: [student],
    arrivals: [arrival()],
    presenceEvents: [
      presenceEvent(),
      presenceEvent({ id: 'e2', event_type: 'departure', occurred_at: '2026-05-04 09:20:00' }),
    ],
    scheduleRows: [schedule()],
    publishedSchoolDays: ['2026-05-04'],
  });

  const row = analytics.students[0];
  assert.equal(row.present_days, 1);
  assert.equal(row.incomplete_days, 1);
  assert.equal(row.days[0].departure_time, '09:20');
});
