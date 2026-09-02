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

export function presenceViewClassScope(role, {
  audience = 'children',
  mentorClassIds = [],
} = {}) {
  const normalizedRole = String(role || '').trim();
  if (normalizedRole === 'admin') return null;
  if (String(audience || '').trim() === 'adults') return [];
  if (normalizedRole === 'mentor') return (mentorClassIds || []).map(String);
  if (normalizedRole === 'teacher' || normalizedRole === 'tutor') return null;
  return [];
}

export function buildPresenceViewState({
  latestEvent = null,
  firstArrival = null,
  absence = null,
  conflicts = [],
  firstLesson = null,
} = {}) {
  const hasEvent = Boolean(latestEvent?.id);
  const isPresent = latestEvent?.event_type === PRESENCE_EVENT_TYPES.ARRIVAL;
  const currentStatusCode = conflicts.length
    ? 'conflict'
    : (absence
      ? 'absent'
      : (hasEvent ? (isPresent ? 'present' : 'departed') : 'none'));
  const lateMinutes = presenceLateMinutes(firstArrival, firstLesson);
  const isLate = Boolean(firstArrival?.id) && (
    firstArrival?.source === 'mentor_manual_late'
    || Number.isInteger(lateMinutes)
  );
  const arrivalTime = presenceEventTime(firstArrival);
  const departureTime = latestEvent?.event_type === PRESENCE_EVENT_TYPES.DEPARTURE
    ? presenceEventTime(latestEvent)
    : '';
  const currentStatusLabel = presenceCurrentStatusLabel(currentStatusCode);
  const lateLabel = isLate
    ? (Number.isInteger(lateMinutes) && lateMinutes > 0 ? `Опоздал на ${lateMinutes} мин` : 'Опоздал')
    : '';
  const conflict = conflicts[0] || null;
  const statusDetail = currentStatusCode === 'conflict'
    ? [conflict?.reason_name, presenceEventTime(conflict)].filter(Boolean).join(' · ')
    : (currentStatusCode === 'absent'
      ? [absence?.reason_name, absence?.period_label].filter(Boolean).join(' · ')
      : '');

  return {
    has_event: hasEvent,
    is_present: currentStatusCode === 'present',
    is_late: isLate,
    late_minutes: Number.isInteger(lateMinutes) ? lateMinutes : null,
    late_label: lateLabel,
    current_status_code: currentStatusCode,
    current_status_label: currentStatusLabel,
    status_code: currentStatusCode === 'present' && isLate ? 'late' : currentStatusCode,
    status_word: currentStatusLabel,
    status_label: [currentStatusLabel, lateLabel].filter(Boolean).join(' · '),
    status_badge_label: currentStatusLabel,
    status_detail: statusDetail,
    arrival_time: arrivalTime,
    arrival_label: arrivalTime ? `Пришёл ${arrivalTime}` : '',
    departure_time: departureTime,
    departure_label: departureTime ? `Ушёл ${departureTime}` : '',
    last_event_id: latestEvent?.id || '',
    last_event_type: latestEvent?.event_type || '',
    next_event_type: isPresent ? PRESENCE_EVENT_TYPES.DEPARTURE : PRESENCE_EVENT_TYPES.ARRIVAL,
    next_action_label: isPresent ? 'Отметить уход' : 'Отметить приход',
    conflict_count: conflicts.length,
    conflict_id: conflict?.id || '',
  };
}

export function buildPresenceBoardTotals(classes = []) {
  const totals = {
    classes: 0,
    students: 0,
    present: 0,
    late: 0,
    departed: 0,
    absent: 0,
    none: 0,
    conflicts: 0,
  };

  for (const classItem of classes || []) {
    const students = classItem?.students || [];
    if (students.length) totals.classes += 1;
    for (const student of students) {
      const state = student?.state || {};
      totals.students += 1;
      if (state.is_present) totals.present += 1;
      if (state.is_late) totals.late += 1;
      if (state.current_status_code === 'departed') totals.departed += 1;
      if (state.current_status_code === 'absent') totals.absent += 1;
      if (state.current_status_code === 'none') totals.none += 1;
      if (state.current_status_code === 'conflict') totals.conflicts += 1;
    }
  }
  return totals;
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

function presenceCurrentStatusLabel(code) {
  if (code === 'present') return 'В школе';
  if (code === 'departed') return 'Ушёл';
  if (code === 'absent') return 'Отсутствует';
  if (code === 'conflict') return 'Требует уточнения';
  return 'Нет отметки';
}

function presenceLateMinutes(firstArrival, firstLesson) {
  if (!firstArrival?.occurred_at || !firstLesson?.starts_at) return null;
  const arrival = sqlDateTimeParts(firstArrival.occurred_at);
  const lesson = sqlDateTimeParts(firstLesson.starts_at);
  if (!arrival || !lesson) return null;
  const minutes = Math.floor((arrival - lesson) / 60_000);
  return minutes > 0 ? minutes : null;
}

function presenceEventTime(event) {
  const direct = String(event?.occurred_time || '').match(/^(\d{2}:\d{2})/);
  if (direct) return direct[1];
  const source = String(event?.occurred_at || '');
  const match = source.match(/[ T](\d{2}:\d{2})(?::\d{2})?/);
  return match ? match[1] : '';
}

function sqlDateTimeParts(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] || 0),
  );
}
