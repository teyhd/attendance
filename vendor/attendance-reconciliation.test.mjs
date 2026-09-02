import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTENDANCE_CONFLICT_RESOLUTIONS,
  conflictInterval,
  isArrivalInsideAbsence,
  normalizeConflictResolution,
} from './attendance-reconciliation.mjs';

const absence = {
  student_id: '10',
  starts_at: '2026-09-01 10:00:00',
  ends_at: '2026-09-01 12:00:00',
};

test('arrival is a conflict only when its exact time is inside the absence', () => {
  assert.equal(isArrivalInsideAbsence({ student_id: '10', event_type: 'arrival', occurred_at: '2026-09-01 11:00:00' }, absence), true);
  assert.equal(isArrivalInsideAbsence({ student_id: '10', event_type: 'arrival', occurred_at: '2026-09-01 09:00:00' }, absence), false);
  assert.equal(isArrivalInsideAbsence({ student_id: '10', event_type: 'arrival', occurred_at: '2026-09-01 12:00:00' }, absence), false);
  assert.equal(isArrivalInsideAbsence({ student_id: '10', event_type: 'departure', occurred_at: '2026-09-01 11:00:00' }, absence), false);
});

test('conflict interval begins at the arrival and ends with the absence', () => {
  assert.deepEqual(conflictInterval({ occurred_at: '2026-09-01 11:00:00', ends_at: '2026-09-01 12:00:00' }), {
    starts_at: '2026-09-01 11:00:00',
    ends_at: '2026-09-01 12:00:00',
  });
});

test('only explicit conflict decisions are accepted', () => {
  assert.equal(normalizeConflictResolution('keep_presence'), ATTENDANCE_CONFLICT_RESOLUTIONS.KEEP_PRESENCE);
  assert.equal(normalizeConflictResolution('keep_absence'), ATTENDANCE_CONFLICT_RESOLUTIONS.KEEP_ABSENCE);
  assert.equal(normalizeConflictResolution('dismiss'), '');
});
