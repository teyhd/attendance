import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFeedbackAttendanceSnapshots,
  buildFeedbackDateRange,
  normalizeFeedbackAssignments,
} from './feedback-snapshots.mjs';

function scheduleRow({ date, entryId, teacherId = 91 }) {
  return {
    entry_id: entryId,
    lesson_date: date,
    day_of_week: new Date(`${date}T00:00:00Z`).getUTCDay() || 7,
    slot_id: 1,
    slot_number: 1,
    start_time: '09:00:00',
    end_time: '10:00:00',
    class_id: 7,
    student_id: null,
    subject_id: 44,
    subject_name: 'Математика',
    teacher_id: teacherId,
    teacher_name: `Педагог ${teacherId}`,
    slot_part: 'FULL',
  };
}

test('buildFeedbackAttendanceSnapshots counts scheduled and missed subject lessons', () => {
  const range = buildFeedbackDateRange('2026-08-24', '2026-08-28');
  const items = buildFeedbackAttendanceSnapshots({
    range,
    assignments: [{ key: 'card-1', studentId: 11, subjectId: 44, teacherId: 91 }],
    students: [{ student_id: 11, class_id: 7, student_name: 'Ученик' }],
    periods: [{
      id: 501,
      student_id: 11,
      class_id: 7,
      starts_at: '2026-08-24 09:00:00',
      ends_at: '2026-08-24 10:00:00',
    }],
    scheduleRows: [
      scheduleRow({ date: '2026-08-24', entryId: 1 }),
      scheduleRow({ date: '2026-08-25', entryId: 2 }),
    ],
    publishedSchoolDays: range.days,
    activeWeekdays: [1, 2, 3, 4, 5],
    calculatedAt: '2026-08-28T20:00:00.000Z',
  });

  assert.deepEqual(items[0], {
    key: 'card-1',
    state: 'complete',
    scheduledLessons: 2,
    missedLessons: 1,
    attendancePercent: 50,
    coveredDays: 5,
    expectedDays: 5,
    algorithmVersion: 'attendance-feedback-v1',
    calculatedAt: '2026-08-28T20:00:00.000Z',
    details: {
      missingScheduleDates: [],
      missed: [{ date: '2026-08-24', lessonId: '1', absenceId: '501' }],
      assignmentTeacherId: 91,
      thresholdMinutes: 15,
    },
  });
});

test('partial schedule coverage does not expose a misleading percentage', () => {
  const range = buildFeedbackDateRange('2026-08-24', '2026-08-28');
  const [item] = buildFeedbackAttendanceSnapshots({
    range,
    assignments: [{ key: 'card-1', studentId: 11, subjectId: 44, teacherId: 91 }],
    students: [{ student_id: 11, class_id: 7 }],
    scheduleRows: [scheduleRow({ date: '2026-08-24', entryId: 1 })],
    publishedSchoolDays: ['2026-08-24', '2026-08-25'],
    activeWeekdays: [1, 2, 3, 4, 5],
  });

  assert.equal(item.state, 'partial');
  assert.equal(item.attendancePercent, null);
  assert.deepEqual(item.details.missingScheduleDates, ['2026-08-26', '2026-08-27', '2026-08-28']);
});

test('subject attendance remains complete when the subject has co-teachers', () => {
  const range = buildFeedbackDateRange('2026-08-24', '2026-08-24');
  const [item] = buildFeedbackAttendanceSnapshots({
    range,
    assignments: [{ key: 'card-2', studentId: 11, subjectId: 44, teacherId: 92 }],
    students: [{ student_id: 11, class_id: 7 }],
    scheduleRows: [
      scheduleRow({ date: '2026-08-24', entryId: 1, teacherId: 91 }),
      scheduleRow({ date: '2026-08-24', entryId: 2, teacherId: 92 }),
    ],
    publishedSchoolDays: ['2026-08-24'],
    activeWeekdays: [1, 2, 3, 4, 5],
  });

  assert.equal(item.scheduledLessons, 1);
  assert.equal(item.attendancePercent, 100);
});

test('normalization rejects duplicate assignment keys and invalid dates', () => {
  assert.throws(() => normalizeFeedbackAssignments([
    { key: 'same', studentId: 1, subjectId: 2, teacherId: 3 },
    { key: 'same', studentId: 4, subjectId: 5, teacherId: 6 },
  ]), /уникальными/);
  assert.throws(() => buildFeedbackDateRange('2026-02-30', '2026-03-01'), /Некорректный/);
});
