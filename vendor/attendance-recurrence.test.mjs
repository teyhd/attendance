import assert from 'node:assert/strict';
import test from 'node:test';
import { expandWeeklyAbsences } from './attendance-recurrence.mjs';

const input = {
  studentId: 327,
  startsAt: '2026-09-23T16:10',
  endsAt: '2026-09-23T19:00',
  reasonCode: 'family',
  comment: 'Тренировка',
};

test('creates only selected weekdays with the same time and comment', () => {
  const items = expandWeeklyAbsences(input, '2026-10-07', ['1', '3']);
  assert.deepEqual(items.map((item) => item.startsAt), [
    '2026-09-23T16:10', '2026-09-28T16:10', '2026-09-30T16:10',
    '2026-10-05T16:10', '2026-10-07T16:10',
  ]);
  assert.equal(items[4].endsAt, '2026-10-07T19:00');
  assert.ok(items.every((item) => item.comment === 'Тренировка'));
});

test('rejects an invalid range, empty weekdays and overnight repeats', () => {
  assert.throws(() => expandWeeklyAbsences(input, '2026-09-22', ['3']), /90 дней/);
  assert.throws(() => expandWeeklyAbsences(input, '2026-10-01', []), /день недели/);
  assert.throws(() => expandWeeklyAbsences({ ...input, endsAt: '2026-09-24T09:00' }, '2026-10-01', ['3']), /в один день/);
  assert.throws(() => expandWeeklyAbsences(input, '2027-01-01', ['3']), /90 дней/);
});

test('limits the number of generated records', () => {
  assert.throws(() => expandWeeklyAbsences(input, '2026-12-22', ['1', '2', '3', '4', '5', '6', '7']), /не более 60/);
});
