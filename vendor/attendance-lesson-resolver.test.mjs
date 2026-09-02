import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLessonResolutionContract,
  normalizeLessonResolutionRequests,
} from './attendance-lesson-resolver.mjs';

const request = normalizeLessonResolutionRequests([{
  key: 'diary-lesson-123',
  sourceLessonId: '123',
  scheduleAnchorEntryId: '456',
  lessonDate: '2026-09-02',
  classId: 31,
  teacherId: 118,
  sourceSubjectId: 179,
  studentIds: [101, 102],
}])[0];

const baseContext = {
  request,
  anchor: { entry_id: '456', week_version_id: '77' },
  scheduleRows: [101, 102].map((studentId) => ({
    entry_id: String(500 + studentId),
    week_version_id: '77',
    lesson_date: '2026-09-02',
    slot_id: '12',
    slot_number: 2,
    start_time: '09:00:00',
    end_time: '10:00:00',
    class_id: '31',
    student_id: String(studentId),
    resolved_student_id: String(studentId),
    subject_id: '999',
    teacher_id: '118',
    slot_part: 'FULL',
  })),
};

const people = [101, 102].map((studentId) => ({
  person_id: String(studentId), user_type: 1, class_id: '31', person_name: 'must-not-leak',
}));

function build(overrides = {}) {
  return buildLessonResolutionContract({
    contexts: [baseContext],
    people,
    now: '2026-09-02 11:00:00',
    ...overrides,
  });
}

test('validates batch limits and exact anchors', () => {
  assert.equal(request.scheduleAnchorEntryId, 456);
  assert.throws(() => normalizeLessonResolutionRequests([{ ...request, studentIds: [] }]), /Некорректный/);
  assert.throws(() => normalizeLessonResolutionRequests(Array.from({ length: 51 }, (_, index) => ({ ...request, key: `k-${index}` }))), /Слишком много уроков/);
});

test('resolves individual schedule rows for every student without comparing Diary subject id', () => {
  const payload = build({
    lessonFacts: [
      { id: 1, student_id: '101', lesson_id: '123', status: 'present', source_version: 1 },
      { id: 2, student_id: '102', lesson_id: '123', status: 'late', late_minutes: 7, source_version: 1 },
    ],
  });
  assert.deepEqual(payload.items[0].students.map((student) => student.status), ['present', 'late']);
  assert.equal(payload.items[0].students[1].lateMinutes, 7);
  assert.equal(JSON.stringify(payload).includes('must-not-leak'), false);
});

test('supports absence reasons, partial coverage, conflicts and future lessons', () => {
  const sick = build({ periods: [{ student_id: '101', starts_at: '2026-09-02 09:00:00', ends_at: '2026-09-02 10:00:00', reason_code: 'illness', is_excused: 1 }] });
  assert.equal(sick.items[0].students[0].status, 'sick');

  const partial = build({ presenceEvents: [
    { student_id: '101', attendance_date: '2026-09-02', event_type: 'arrival', occurred_at: '2026-09-02 09:10:00' },
    { student_id: '101', attendance_date: '2026-09-02', event_type: 'departure', occurred_at: '2026-09-02 09:30:00' },
  ] });
  assert.equal(partial.items[0].students[0].resolution, 'partial');
  assert.equal(partial.items[0].students[0].status, null);

  const conflicting = build({
    lessonFacts: [{ student_id: '101', lesson_id: '123', status: 'present', source_version: 1 }],
    periods: [{ student_id: '101', starts_at: '2026-09-02 09:00:00', ends_at: '2026-09-02 10:00:00', reason_code: 'illness', is_excused: 1 }],
  });
  assert.equal(conflicting.items[0].students[0].resolution, 'conflict');

  const future = buildLessonResolutionContract({ contexts: [baseContext], people, now: '2026-09-02 08:00:00' });
  assert.equal(future.items[0].students[0].resolution, 'not_started');
});

test('does not guess a legacy lesson when anchor cannot be validated', () => {
  const payload = buildLessonResolutionContract({
    contexts: [{ request, anchor: null, anchorError: 'schedule_anchor_not_found', scheduleRows: [] }],
    people,
    now: '2026-09-02 11:00:00',
  });
  assert.equal(payload.items[0].students[0].resolution, 'unavailable');
  assert.deepEqual(payload.items[0].students[0].qualityIssues, ['schedule_anchor_not_found']);
});
