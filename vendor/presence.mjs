export const PRESENCE_EVENT_TYPES = {
  ARRIVAL: 'arrival',
  DEPARTURE: 'departure',
};

export const MANUAL_PRESENCE_SOURCES = new Set(['tablet', 'mentor_manual_late']);

export function resolvePresenceToggle({
  latestEvent = null,
} = {}) {
  return {
    shouldInsert: true,
    duplicate: false,
    eventType: nextPresenceEventType(latestEvent),
  };
}

export function nextPresenceEventType(latestEvent) {
  if (!latestEvent?.event_type) return PRESENCE_EVENT_TYPES.ARRIVAL;
  return normalizePresenceEventType(latestEvent?.event_type) === PRESENCE_EVENT_TYPES.ARRIVAL
    ? PRESENCE_EVENT_TYPES.DEPARTURE
    : PRESENCE_EVENT_TYPES.ARRIVAL;
}

export function isManualPresenceEvent(event) {
  return MANUAL_PRESENCE_SOURCES.has(String(event?.source || '').trim());
}

export function canManagePresenceClass(classIds, classId) {
  return classIds === null || (classIds || []).map(String).includes(String(classId || ''));
}

export function canCancelPresenceEvent(event, {
  latestEvent = null,
  attendanceDate = '',
  allowAutomaticLatest = false,
} = {}) {
  if (!event || event.cancelled_at) return false;
  if (attendanceDate && String(event.attendance_date) !== String(attendanceDate)) return false;
  if (isManualPresenceEvent(event)) return true;
  if (!allowAutomaticLatest || !latestEvent || latestEvent.cancelled_at) return false;
  return String(event.id) === String(latestEvent.id);
}

export function normalizePresenceEventType(value) {
  return value === PRESENCE_EVENT_TYPES.DEPARTURE
    ? PRESENCE_EVENT_TYPES.DEPARTURE
    : PRESENCE_EVENT_TYPES.ARRIVAL;
}
