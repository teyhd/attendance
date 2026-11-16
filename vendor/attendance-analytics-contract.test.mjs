import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalyticsRange,
  buildAttendanceAnalyticsContract,
  normalizeAnalyticsItems,
} from './attendance-analytics-contract.mjs';
import { buildScheduledAttendanceAnalytics } from './attendance-timeline.mjs';
import { buildLearningAnalytics } from './learning-analytics.mjs';

const range = buildAnalyticsRange('2026-09-01', '2026-09-02');
const scheduleRows = [
  { entry_id: '101', lesson_date: '2026-09-01', day_of_week: 2, slot_id: '1', slot_number: 1, start_time: '09:00:00', end_time: '10:00:00', class_id: '10', subject_id: '20', subject_name: 'Математика', teacher_id: '30' },
  { entry_id: '102', lesson_date: '2026-09-02', day_of_week: 3, slot_id: '1', slot_number: 1, start_time: '09:00:00', end_time: '10:00:00', class_id: '10', subject_id: '20', subject_name: 'Математика', teacher_id: '30' },
];

function oneDayInput(overrides = {}) {
  return {
    range: buildAnalyticsRange('2026-09-01', '2026-09-01'),
    items: normalizeAnalyticsItems([{ key: 'student', personId: 7 }]),
    people: [{ person_id: '7', user_type: 1, class_id: '10' }],
    students: [{ student_id: '7', class_id: '10' }],
    scheduleRows: [scheduleRows[0]], publishedSchoolDays: ['2026-09-01'], activeWeekdays: [2],
    now: '2026-09-01 18:00:00', ...overrides,
  };
}

function presence(at, type, id) {
  return { id, student_id: '7', event_type: type, attendance_date: at.slice(0, 10), occurred_at: at };
}

test('UI, lesson details and service metrics use the same disjoint presence and absence intervals', () => {
  const input = oneDayInput({
    presenceEvents: [presence('2026-09-01 09:15:00', 'arrival', '1'), presence('2026-09-01 09:45:00', 'departure', '2')],
    periods: [{ id: '1', student_id: '7', class_id: '10', starts_at: '2026-09-01 09:00:00', ends_at: '2026-09-01 09:15:00', reason_code: 'illness', reason_name: 'Болезнь', is_excused: 1 }],
  });
  const summary = buildAttendanceAnalyticsContract(input).items[0].summary;
  const timeline = buildScheduledAttendanceAnalytics(input);
  const learning = buildLearningAnalytics({ ...input, includeLessons: true });
  assert.equal(summary.attendedMinutes, 30);
  assert.equal(summary.missedMinutes, 30);
  assert.equal(summary.noMarkMinutes, 15);
  assert.equal(summary.attendancePercent, 50);
  assert.equal(timeline.actual.attended_minutes, summary.attendedMinutes);
  assert.equal(timeline.actual.missed_minutes, summary.missedMinutes);
  assert.equal(timeline.actual.attendance_percent, summary.attendancePercent);
  assert.equal(learning.lessons.length, 1);
  assert.equal(learning.lessons[0].absence_minutes, summary.missedMinutes);
  assert.equal(learning.missed_lessons_total, summary.missedLessons);
  assert.equal(learning.lessons[0].is_unconfirmed, true);
});

test('an explicit missed lesson is compatible with being inside the school', () => {
  const input = oneDayInput({
    presenceEvents: [presence('2026-09-01 08:50:00', 'arrival', '1'), presence('2026-09-01 10:10:00', 'departure', '2')],
    lessonFacts: [{ id: '1', student_id: '7', lesson_date: '2026-09-01', schedule_entry_id: '101', subject_id: '20', status: 'absent', source_version: 1 }],
  });
  const result = buildAttendanceAnalyticsContract(input).items[0];
  assert.equal(result.summary.confirmedAbsenceMinutes, 60);
  assert.equal(result.summary.conflictMinutes, 0);
  assert.equal(result.summary.noMarkMinutes, 0);
  assert.equal(result.summary.attendancePercent, 0);
  assert.equal(buildScheduledAttendanceAnalytics(input).actual.missed_minutes, 60);
  assert.equal(buildLearningAnalytics({ ...input, includeLessons: true }).lessons[0].is_unconfirmed, false);
});

test('a conflict excludes only its overlapping minutes and does not spread to another lesson', () => {
  const secondLesson = { ...scheduleRows[0], entry_id: '103', slot_id: '2', slot_number: 2, start_time: '10:00:00', end_time: '11:00:00', subject_id: '21' };
  const input = oneDayInput({
    scheduleRows: [scheduleRows[0], secondLesson],
    presenceEvents: [presence('2026-09-01 08:50:00', 'arrival', '1'), presence('2026-09-01 11:00:00', 'departure', '2')],
    periods: [{ id: '1', student_id: '7', starts_at: '2026-09-01 10:15:00', ends_at: '2026-09-01 10:30:00' }],
    conflicts: [{ student_id: '7', status: 'open', occurred_at: '2026-09-01 10:15:00', ends_at: '2026-09-01 10:30:00' }],
  });
  const result = buildAttendanceAnalyticsContract(input).items[0];
  assert.equal(result.summary.conflictMinutes, 15);
  assert.equal(result.summary.attendedMinutes, 105);
  assert.equal(result.subjects.find(row => row.subjectId === 20).conflictMinutes, 0);
  assert.equal(buildScheduledAttendanceAnalytics(input).actual.conflict_minutes, 15);
});

test('a subject-only fact is not copied to two lessons of the same subject', () => {
  const secondLesson = { ...scheduleRows[0], entry_id: '103', slot_id: '2', slot_number: 2, start_time: '10:00:00', end_time: '11:00:00' };
  const result = buildAttendanceAnalyticsContract(oneDayInput({
    scheduleRows: [scheduleRows[0], secondLesson],
    lessonFacts: [{ id: '1', student_id: '7', lesson_date: '2026-09-01', subject_id: '20', status: 'present', source_version: 1 }],
  })).items[0];
  assert.equal(result.summary.attendedMinutes, 0);
  assert.equal(result.summary.noMarkMinutes, 120);
  assert.ok(result.quality.issues.some(issue => issue.code === 'ambiguous_lesson_fact'));
});

test('an exact fact for another lesson never falls back to the subject', () => {
  const result = buildAttendanceAnalyticsContract(oneDayInput({
    lessonFacts: [{ id: '1', student_id: '7', lesson_date: '2026-09-01', schedule_entry_id: '999', subject_id: '20', status: 'present', source_version: 1 }],
  })).items[0];
  assert.equal(result.summary.attendedMinutes, 0);
  assert.equal(result.summary.noMarkMinutes, 60);
  assert.ok(result.quality.issues.some(issue => issue.code === 'unmatched_lesson_fact'));
});

test('missing student schedule returns an unavailable percentage rather than zero attendance', () => {
  const input = oneDayInput({ scheduleRows: [], presenceEvents: [] });
  const internal = buildAttendanceAnalyticsContract(input).items[0];
  const timeline = buildScheduledAttendanceAnalytics(input);
  const learning = buildLearningAnalytics({ ...input, includeLessons: true });
  assert.equal(internal.summary.attendancePercent, null);
  assert.equal(timeline.actual.attendance_percent, null);
  assert.deepEqual(internal.quality.missingScheduleDates, ['2026-09-01']);
  assert.equal(learning.data_gaps_total, 1);
  assert.equal(learning.lessons.length, 0);
});

test('internal canonical person ids resolve individual schedules', () => {
  const individual = { ...scheduleRows[0], entry_id: 'individual', student_id: '7', subject_id: '22', subject_name: 'Индивидуально' };
  const result = buildAttendanceAnalyticsContract(oneDayInput({ scheduleRows: [scheduleRows[0], individual] })).items[0];
  assert.equal(result.summary.scheduledLessons, 1);
  assert.equal(result.subjects[0].subjectId, 22);
});

test('range and request validation are bounded and stable', () => {
  assert.equal(range.days_count, 2);
  assert.deepEqual(normalizeAnalyticsItems([{ key: 'a', studentId: 7, subjectId: 20 }]), [{ key: 'a', personId: 7, personType: 'student', subjectId: 20, teacherId: null }]);
  assert.throws(() => buildAnalyticsRange('2026-09-02', '2026-09-01'), /позже/);
  assert.equal(buildAnalyticsRange('2025-09-02', '2026-09-02').days_count, 366);
  assert.throws(() => buildAnalyticsRange('2025-09-01', '2026-09-02'), /слишком большой/);
});

test('student analytics combines presence, lateness and classified absence at lesson grain', () => {
  const payload = buildAttendanceAnalyticsContract({
    range,
    items: normalizeAnalyticsItems([{ key: 'student', personId: 7, personType: 'student' }]),
    people: [{ person_id: '7', user_type: 1, person_name: 'Ученик', class_id: '10', class_name: '5-1' }],
    scheduleRows,
    publishedSchoolDays: ['2026-09-01', '2026-09-02'],
    activeWeekdays: [2, 3],
    presenceEvents: [
      { id: '1', student_id: '7', event_type: 'arrival', attendance_date: '2026-09-01', occurred_at: '2026-09-01 09:10:00' },
      { id: '2', student_id: '7', event_type: 'departure', attendance_date: '2026-09-01', occurred_at: '2026-09-01 10:00:00' },
    ],
    periods: [{ student_id: '7', starts_at: '2026-09-02 09:00:00', ends_at: '2026-09-02 10:00:00', reason_code: 'illness', reason_name: 'Болезнь', is_excused: 1 }],
    now: '2026-09-02 18:00:00',
  });
  const item = payload.items[0];
  assert.equal(item.state, 'complete');
  assert.equal(item.summary.scheduledMinutes, 120);
  assert.equal(item.summary.attendedMinutes, 50);
  assert.equal(item.summary.missedMinutes, 70);
  assert.equal(item.summary.lateMinutes, 10);
  assert.equal(item.summary.attendancePercent, 41.67);
  assert.equal(item.summary.unexcusedLessons, 0);
  assert.equal(item.summary.withoutReasonLessons, 1);
  assert.deepEqual(item.absenceByReason.map((reason) => reason.code), ['illness', 'no_mark']);
});

test('Diary lesson mark and mentor absence contradiction becomes excluded conflict', () => {
  const payload = buildAttendanceAnalyticsContract({
    range: buildAnalyticsRange('2026-09-02', '2026-09-02'),
    items: normalizeAnalyticsItems([{ key: 'student', personId: 7 }]),
    people: [{ person_id: '7', user_type: 1, class_id: '10' }],
    scheduleRows: [scheduleRows[1]],
    publishedSchoolDays: ['2026-09-02'],
    activeWeekdays: [3],
    periods: [{ student_id: '7', starts_at: '2026-09-02 09:00:00', ends_at: '2026-09-02 10:00:00', reason_code: 'illness', reason_name: 'Болезнь', is_excused: 1 }],
    lessonFacts: [{ id: 1, student_id: '7', lesson_date: '2026-09-02', schedule_entry_id: '102', subject_id: '20', status: 'present', source_version: 1 }],
    now: '2026-09-02 18:00:00',
  });
  assert.equal(payload.items[0].state, 'partial');
  assert.equal(payload.items[0].summary.conflictMinutes, 60);
  assert.equal(payload.items[0].summary.attendancePercent, null);
});

test('employee analytics never invents an expected norm or lateness', () => {
  const payload = buildAttendanceAnalyticsContract({
    range: buildAnalyticsRange('2026-09-01', '2026-09-01'),
    items: normalizeAnalyticsItems([{ key: 'employee', personId: 9, personType: 'employee' }]),
    people: [{ person_id: '9', user_type: 2, person_name: 'Сотрудник', department_id: '4' }],
    presenceEvents: [
      { id: 1, student_id: '9', event_type: 'arrival', attendance_date: '2026-09-01', occurred_at: '2026-09-01 08:30:00' },
      { id: 2, student_id: '9', event_type: 'departure', attendance_date: '2026-09-01', occurred_at: '2026-09-01 17:00:00' },
    ],
    now: '2026-09-02 00:00:00',
  });
  const summary = payload.items[0].summary;
  assert.equal(summary.onsiteMinutes, 510);
  assert.equal(summary.attendancePercent, null);
  assert.equal(summary.lateMinutes, null);
  assert.equal(summary.expectedMinutes, null);
});

test('rejects analytics when the requested person type does not match SSO', () => {
  const payload = buildAttendanceAnalyticsContract({
    range: buildAnalyticsRange('2026-09-01', '2026-09-01'),
    items: normalizeAnalyticsItems([{ key: 'wrong-type', personId: 7, personType: 'employee' }]),
    people: [{ person_id: '7', user_type: 1, person_name: 'Ученик' }],
  });

  assert.equal(payload.items[0].state, 'unavailable');
  assert.deepEqual(payload.items[0].quality.issues, [{ code: 'person_type_mismatch' }]);
});

test('subject and teacher scope filters summary, daily rows, and absence reasons together', () => {
  const scopedSchedule = [
    scheduleRows[0],
    { entry_id: '103', lesson_date: '2026-09-01', day_of_week: 2, slot_id: '2', slot_number: 2, start_time: '10:00:00', end_time: '11:00:00', class_id: '10', subject_id: '21', subject_name: 'История', teacher_id: '31' },
  ];
  const payload = buildAttendanceAnalyticsContract({
    range: buildAnalyticsRange('2026-09-01', '2026-09-01'),
    items: normalizeAnalyticsItems([{ key: 'math', personId: 7, subjectId: 20, teacherId: 30 }]),
    people: [{ person_id: '7', user_type: 1, class_id: '10' }],
    scheduleRows: scopedSchedule,
    publishedSchoolDays: ['2026-09-01'],
    activeWeekdays: [2],
    lessonFacts: [
      { id: 1, student_id: '7', lesson_date: '2026-09-01', schedule_entry_id: '101', subject_id: '20', status: 'present', source_version: 1 },
      { id: 2, student_id: '7', lesson_date: '2026-09-01', schedule_entry_id: '103', subject_id: '21', status: 'sick', source_version: 1 },
    ],
    now: '2026-09-01 18:00:00',
  });

  const item = payload.items[0];
  assert.equal(item.summary.scheduledLessons, 1);
  assert.equal(item.summary.attendancePercent, 100);
  assert.equal(item.subjects.length, 1);
  assert.equal(item.subjects[0].subjectId, 20);
  assert.equal(item.daily[0].scheduledLessons, 1);
  assert.deepEqual(item.absenceByReason, []);
});

test('a contradiction in another subject does not invalidate a scoped subject result', () => {
  const payload = buildAttendanceAnalyticsContract({
    range: buildAnalyticsRange('2026-09-01', '2026-09-01'),
    items: normalizeAnalyticsItems([{ key: 'math', personId: 7, subjectId: 20, teacherId: 30 }]),
    people: [{ person_id: '7', user_type: 1, class_id: '10' }],
    scheduleRows: [
      scheduleRows[0],
      { entry_id: '103', lesson_date: '2026-09-01', day_of_week: 2, slot_id: '2', slot_number: 2, start_time: '10:00:00', end_time: '11:00:00', class_id: '10', subject_id: '21', subject_name: 'История', teacher_id: '31' },
    ],
    publishedSchoolDays: ['2026-09-01'],
    activeWeekdays: [2],
    periods: [{ student_id: '7', starts_at: '2026-09-01 10:00:00', ends_at: '2026-09-01 11:00:00', reason_code: 'illness', reason_name: 'Болезнь', is_excused: 1 }],
    lessonFacts: [
      { id: 1, student_id: '7', lesson_date: '2026-09-01', schedule_entry_id: '101', subject_id: '20', status: 'present', source_version: 1 },
      { id: 2, student_id: '7', lesson_date: '2026-09-01', schedule_entry_id: '103', subject_id: '21', status: 'present', source_version: 1 },
    ],
    now: '2026-09-01 18:00:00',
  });

  assert.equal(payload.items[0].state, 'complete');
  assert.equal(payload.items[0].summary.attendancePercent, 100);
  assert.deepEqual(payload.items[0].quality.issues, []);
});
