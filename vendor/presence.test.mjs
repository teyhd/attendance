import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENCE_EVENT_TYPES,
  canCancelPresenceEvent,
  canManagePresenceClass,
  isManualPresenceEvent,
  nextPresenceEventType,
  resolvePresenceToggle,
} from './presence.mjs';

test('presence toggle starts with arrival and alternates events', () => {
  assert.equal(nextPresenceEventType(null), PRESENCE_EVENT_TYPES.ARRIVAL);
  assert.equal(nextPresenceEventType({ event_type: 'arrival' }), PRESENCE_EVENT_TYPES.DEPARTURE);
  assert.equal(nextPresenceEventType({ event_type: 'departure' }), PRESENCE_EVENT_TYPES.ARRIVAL);
});

test('presence toggle inserts departure on a fast repeated tap', () => {
  const result = resolvePresenceToggle({
    latestEvent: { event_type: 'arrival', occurred_at: '2026-05-22 08:00:00' },
    now: '2026-05-22 08:00:05',
  });

  assert.deepEqual(result, {
    shouldInsert: true,
    duplicate: false,
    eventType: PRESENCE_EVENT_TYPES.DEPARTURE,
  });
});

test('presence toggle keeps alternating after any delay', () => {
  const result = resolvePresenceToggle({
    latestEvent: { event_type: 'arrival', occurred_at: '2026-05-22 08:00:00' },
    now: '2026-05-22 08:00:11',
  });

  assert.deepEqual(result, {
    shouldInsert: true,
    duplicate: false,
    eventType: PRESENCE_EVENT_TYPES.DEPARTURE,
  });
});

test('manual presence events can be cancelled from any point in the current-day history', () => {
  const event = { id: '10', source: 'tablet', attendance_date: '2026-05-22' };

  assert.equal(isManualPresenceEvent(event), true);
  assert.equal(canCancelPresenceEvent(event, {
    latestEvent: { id: '11', source: 'tablet' },
    attendanceDate: '2026-05-22',
  }), true);
});

test('presence cancellation rejects cancelled, older, and automatic events', () => {
  assert.equal(canCancelPresenceEvent({
    id: '10',
    source: 'tablet',
    attendance_date: '2026-05-22',
    cancelled_at: '2026-05-22 08:00:01',
  }, { attendanceDate: '2026-05-22' }), false);
  assert.equal(canCancelPresenceEvent({
    id: '10',
    source: 'tablet',
    attendance_date: '2026-05-21',
  }, { attendanceDate: '2026-05-22' }), false);
  assert.equal(canCancelPresenceEvent({
    id: '10',
    source: 'face',
    attendance_date: '2026-05-22',
  }, { attendanceDate: '2026-05-22' }), false);
});

test('admins may retain the existing undo for the latest automatic event', () => {
  const event = { id: '10', source: 'face', attendance_date: '2026-05-22' };
  assert.equal(canCancelPresenceEvent(event, {
    latestEvent: event,
    attendanceDate: '2026-05-22',
    allowAutomaticLatest: true,
  }), true);
});

test('class scope lets administrators manage every child and mentors only assigned classes', () => {
  assert.equal(canManagePresenceClass(null, '12'), true);
  assert.equal(canManagePresenceClass(['12', '14'], 12), true);
  assert.equal(canManagePresenceClass(['12', '14'], '13'), false);
  assert.equal(canManagePresenceClass([], '12'), false);
});
