import assert from 'node:assert/strict';
import test from 'node:test';

import { buildActiveClassList, studentCountLabel } from './classes.mjs';

test('buildActiveClassList keeps only classes with active students', () => {
  const classes = buildActiveClassList([
    { id: 100, name: '11', students_count: 0 },
    { id: 1, name: '1', students_count: 24 },
    { id: 50, name: 'ДШК', students_count: 12 },
    { id: 2, name: '2', students_count: 0 },
  ]);

  assert.deepEqual(
    classes.map((item) => item.name),
    ['1', 'ДШК'],
  );
  assert.equal(classes[0].students_count, 24);
});

test('studentCountLabel uses Russian plural forms', () => {
  assert.equal(studentCountLabel(1), '1 ученик');
  assert.equal(studentCountLabel(2), '2 ученика');
  assert.equal(studentCountLabel(5), '5 учеников');
  assert.equal(studentCountLabel(24), '24 ученика');
  assert.equal(studentCountLabel(11), '11 учеников');
});
