import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClassLessonStatus } from './schedule-analytics.mjs';

const lesson = (overrides = {}) => ({
  entry_id: '1',
  lesson_date: '2026-09-02',
  class_id: '10',
  subject_id: '7',
  subject_name: 'Математика',
  teacher_id: '15',
  room_id: '2',
  room_name: '205',
  slot_id: '3',
  slot_number: 3,
  start_time: '10:00:00',
  end_time: '10:40:00',
  ...overrides,
});

test('class lesson status exposes the current lesson room and removes duplicate group rows', () => {
  const status = buildClassLessonStatus([lesson(), lesson({ entry_id: '2' })], {
    classId: '10',
    date: '2026-09-02',
    now: '2026-09-02 10:15:00',
  });

  assert.deepEqual(status, {
    status_code: 'current',
    status_label: 'Сейчас',
    has_lesson: true,
    subject_label: 'Математика',
    time_label: '10:00-10:40',
    room_label: '205',
    has_room: true,
  });
});

test('class lesson status joins rooms for simultaneous group lessons', () => {
  const status = buildClassLessonStatus([
    lesson({ subject_id: '8', subject_name: 'Английский язык', room_id: '2', room_name: '205' }),
    lesson({ entry_id: '2', subject_id: '8', subject_name: 'Английский язык', teacher_id: '16', room_id: '3', room_name: '206' }),
  ], {
    classId: '10',
    date: '2026-09-02',
    now: '2026-09-02 09:00:00',
  });

  assert.equal(status.status_code, 'next');
  assert.equal(status.room_label, '205, 206');
  assert.equal(status.subject_label, 'Английский язык');
});

test('class lesson status calls out a missing room', () => {
  const status = buildClassLessonStatus([lesson({ room_id: null, room_name: '' })], {
    classId: '10',
    date: '2026-09-02',
    now: '2026-09-02 10:15:00',
  });

  assert.equal(status.has_lesson, true);
  assert.equal(status.has_room, false);
  assert.equal(status.room_label, '');
});

test('class lesson status reports when the school day is over', () => {
  const status = buildClassLessonStatus([lesson()], {
    classId: '10',
    date: '2026-09-02',
    now: '2026-09-02 18:00:00',
  });

  assert.equal(status.status_code, 'finished');
  assert.equal(status.has_lesson, false);
});
