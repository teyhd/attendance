export const PRESENCE_EVENT_TYPES = {
  ARRIVAL: 'arrival',
  DEPARTURE: 'departure',
};

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

export function canCancelPresenceEvent(event, latestEvent) {
  if (!event || !latestEvent) return false;
  if (event.cancelled_at || latestEvent.cancelled_at) return false;
  return String(event.id) === String(latestEvent.id);
}

export function normalizePresenceEventType(value) {
  return value === PRESENCE_EVENT_TYPES.DEPARTURE
    ? PRESENCE_EVENT_TYPES.DEPARTURE
    : PRESENCE_EVENT_TYPES.ARRIVAL;
}
