import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENCE_EVENT_TYPES,
  canCancelPresenceEvent,
  nextPresenceEventType,
  resolvePresenceToggle,
} from './presence.mjs';

test('presence toggle starts with arrival and alternates events', () => {
  assert.equal(nextPresenceEventType(null), PRESENCE_EVENT_TYPES.ARRIVAL);
  assert.equal(nextPresenceEventType({ event_type: 'arrival' }), PRESENCE_EVENT_TYPES.DEPARTURE);
  assert.equal(nextPresenceEventType({ event_type: 'departure' }), PRESENCE_EVENT_TYPES.ARRIVAL);
});

test('presence toggle treats fast repeated tap as duplicate', () => {
  const result = resolvePresenceToggle({
    latestEvent: { event_type: 'arrival', occurred_at: '2026-05-22 08:00:00' },
    now: '2026-05-22 08:00:05',
  });

  assert.deepEqual(result, {
    shouldInsert: false,
    duplicate: true,
    eventType: PRESENCE_EVENT_TYPES.ARRIVAL,
  });
});

test('presence toggle inserts next event after duplicate window', () => {
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

test('presence cancel is allowed only for latest active event', () => {
  assert.equal(canCancelPresenceEvent({ id: '10' }, { id: '10' }), true);
  assert.equal(canCancelPresenceEvent({ id: '10' }, { id: '11' }), false);
  assert.equal(canCancelPresenceEvent({ id: '10', cancelled_at: '2026-05-22 08:00:01' }, { id: '10' }), false);
});
