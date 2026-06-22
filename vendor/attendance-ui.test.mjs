import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAttendanceActions } from './attendance-ui.mjs';

test('buildAttendanceActions exposes only useful absence actions', () => {
  const labels = buildAttendanceActions(true).map((item) => item.label);

  assert.deepEqual(labels, ['Запланировать отсутствие']);
  assert.equal(labels.includes('По причине'), false);
  assert.equal(labels.includes('Сейчас'), false);
  assert.equal(labels.includes('Без причины'), false);
  assert.equal(labels.includes('Будущее'), false);
  assert.equal(labels.includes('Требуют внимания'), false);
});

test('buildAttendanceActions is empty for read-only users', () => {
  assert.deepEqual(buildAttendanceActions(false), []);
});
