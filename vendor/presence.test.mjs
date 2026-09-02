import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENCE_EVENT_TYPES,
  buildPresenceBoardTotals,
  buildPresenceViewState,
  canCancelPresenceEvent,
  canManagePresenceClass,
  isManualPresenceEvent,
  nextPresenceEventType,
  presenceViewClassScope,
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

test('presence board visibility matches staff roles and audience', () => {
  assert.equal(presenceViewClassScope('admin'), null);
  assert.equal(presenceViewClassScope('teacher'), null);
  assert.equal(presenceViewClassScope('tutor'), null);
  assert.deepEqual(presenceViewClassScope('mentor', { mentorClassIds: ['12', 14] }), ['12', '14']);
  assert.deepEqual(presenceViewClassScope('teacher', { audience: 'adults' }), []);
  assert.deepEqual(presenceViewClassScope('guest'), []);
});

test('presence view separates current location from lateness', () => {
  const firstArrival = {
    id: '1',
    event_type: 'arrival',
    occurred_at: '2026-09-02 09:12:00',
    occurred_time: '09:12:00',
    source: 'face',
  };
  const latePresent = buildPresenceViewState({
    latestEvent: firstArrival,
    firstArrival,
    firstLesson: { starts_at: '2026-09-02 09:00:00' },
  });
  assert.equal(latePresent.current_status_code, 'present');
  assert.equal(latePresent.is_present, true);
  assert.equal(latePresent.is_late, true);
  assert.equal(latePresent.late_minutes, 12);
  assert.equal(latePresent.arrival_time, '09:12');

  const departed = buildPresenceViewState({
    latestEvent: { id: '2', event_type: 'departure', occurred_at: '2026-09-02 14:26:00' },
    firstArrival,
    firstLesson: { starts_at: '2026-09-02 09:00:00' },
  });
  assert.equal(departed.current_status_code, 'departed');
  assert.equal(departed.is_present, false);
  assert.equal(departed.is_late, true);
  assert.equal(departed.departure_time, '14:26');
});

test('presence view covers absence, no mark, and conflict precedence', () => {
  const absent = buildPresenceViewState({ absence: { reason_name: 'Болезнь', period_label: 'весь день' } });
  assert.equal(absent.current_status_code, 'absent');
  assert.equal(absent.status_detail, 'Болезнь · весь день');

  const none = buildPresenceViewState();
  assert.equal(none.current_status_code, 'none');
  assert.equal(none.current_status_label, 'Нет отметки');

  const conflict = buildPresenceViewState({
    latestEvent: { id: '2', event_type: 'arrival', occurred_at: '2026-09-02 09:10:00' },
    absence: { reason_name: 'Болезнь' },
    conflicts: [{ id: '9', reason_name: 'Болезнь', occurred_at: '2026-09-02 09:10:00' }],
  });
  assert.equal(conflict.current_status_code, 'conflict');
  assert.equal(conflict.current_status_label, 'Требует уточнения');
  assert.equal(conflict.conflict_id, '9');
});

test('presence totals keep late arrivals as an overlapping metric', () => {
  const totals = buildPresenceBoardTotals([{ students: [
    { state: { current_status_code: 'present', is_present: true, is_late: false } },
    { state: { current_status_code: 'present', is_present: true, is_late: true } },
    { state: { current_status_code: 'departed', is_present: false, is_late: true } },
    { state: { current_status_code: 'absent', is_present: false, is_late: false } },
    { state: { current_status_code: 'none', is_present: false, is_late: false } },
    { state: { current_status_code: 'conflict', is_present: false, is_late: false } },
  ] }]);

  assert.deepEqual(totals, {
    classes: 1,
    students: 6,
    present: 2,
    late: 2,
    departed: 1,
    absent: 1,
    none: 1,
    conflicts: 1,
  });
});
