export const PRESENCE_EVENT_TYPES = {
  ARRIVAL: 'arrival',
  DEPARTURE: 'departure',
};

export const PRESENCE_DUPLICATE_TAP_WINDOW_SECONDS = 10;

export function resolvePresenceToggle({
  latestEvent = null,
  now,
  duplicateWindowSeconds = PRESENCE_DUPLICATE_TAP_WINDOW_SECONDS,
} = {}) {
  const normalizedNow = parseDateTimeMs(now);
  if (latestEvent && normalizedNow != null) {
    const latestMs = parseDateTimeMs(latestEvent.occurred_at);
    const secondsSinceLatest = latestMs == null ? Number.POSITIVE_INFINITY : (normalizedNow - latestMs) / 1000;
    if (secondsSinceLatest >= 0 && secondsSinceLatest <= duplicateWindowSeconds) {
      return {
        shouldInsert: false,
        duplicate: true,
        eventType: normalizePresenceEventType(latestEvent.event_type),
      };
    }
  }

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

function parseDateTimeMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}
