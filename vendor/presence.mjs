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
  arrivalAssessment = null,
} = {}) {
  const hasEvent = Boolean(latestEvent?.id);
  const isPresent = latestEvent?.event_type === PRESENCE_EVENT_TYPES.ARRIVAL;
  const currentStatusCode = conflicts.length
    ? 'conflict'
    : (absence
      ? 'absent'
      : (hasEvent ? (isPresent ? 'present' : 'departed') : 'none'));
  const lateMinutes = arrivalAssessment
    ? (arrivalAssessment.status === 'late' ? arrivalAssessment.late_minutes : null)
    : presenceLateMinutes(firstArrival, firstLesson);
  const isLate = arrivalAssessment ? arrivalAssessment.status === 'late' : Boolean(firstArrival?.id) && (
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
  const scheduleDetail = arrivalAssessment
    ? (arrivalAssessment.lesson_time && arrivalAssessment.lesson_time !== '—'
      ? `Первый очный урок ${arrivalAssessment.lesson_time.slice(0, 5)}${arrivalAssessment.lesson_label ? ` · ${arrivalAssessment.lesson_label}` : ''}`
      : arrivalAssessment.status_label)
    : '';
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
    status_detail: [statusDetail, scheduleDetail].filter(Boolean).join(' · '),
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
  if (isManualPresenceEvent(event)) return true;
  if (!allowAutomaticLatest || !latestEvent || latestEvent.cancelled_at) return false;
  return String(event.id) === String(latestEvent.id);
}

// These capabilities are also returned by the history API; clients do not infer permissions.
export function presenceHistoryCapabilities(event, { roleId, classIds = [], canMarkAbsence = false } = {}) {
  const active = Boolean(event) && !event.cancelled_at;
  const role = Number(roleId);
  const allowed = role === 5 || (
    event?.source === 'mentor_manual_late'
      ? canMarkAbsence
      : role === 3 && isManualPresenceEvent(event) && canManagePresenceClass(classIds, event?.class_id)
  );
  return { can_edit: active && allowed, can_cancel: active && allowed };
}

export function historyVersion(record) {
  return `${record?.updated_at || ''}#${Number(record?.revision || 0)}`;
}

export function assertHistoryVersion(record, expected) {
  if (expected == null || expected === '') return;
  if (String(expected) !== historyVersion(record)
    && !(Number(record?.revision || 0) === 0 && String(expected) === String(record?.updated_at || ''))) {
    throw Object.assign(new Error('Отметка уже изменена. Обновите историю и повторите действие.'), { status: 409 });
  }
}

export function encodeHistoryCursor(item) {
  return Buffer.from(JSON.stringify([item.occurred_at, item.kind, String(item.id)])).toString('base64url');
}

export function decodeHistoryCursor(value) {
  if (!value) return null;
  try {
    if (String(value).length > 256) throw new Error();
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(cursor) || cursor.length !== 3
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cursor[0])
      || !['absence', 'presence'].includes(cursor[1]) || !/^[1-9]\d*$/.test(cursor[2])) throw new Error();
    return { occurred_at: cursor[0], kind: cursor[1], id: cursor[2] };
  } catch {
    throw Object.assign(new Error('Некорректный указатель страницы истории'), { status: 400 });
  }
}

export function assertPresenceSequenceCorrection(events, before, after) {
  const active = (events || []).filter((event) => !event.cancelled_at);
  const baseline = presenceSequenceProblems(active);
  const corrected = active.filter((event) => String(event.id) !== String(before.id)).concat(after);
  const introduced = [...presenceSequenceProblems(corrected)].some((problem) => !baseline.has(problem));
  if (introduced) {
    throw Object.assign(new Error('Исправление нарушает порядок прихода и ухода. Проверьте соседние отметки.'), { status: 409 });
  }
}

function presenceSequenceProblems(events) {
  const days = new Map();
  for (const event of events) {
    const date = event.attendance_date || String(event.occurred_at).slice(0, 10);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(event);
  }
  const problems = new Set();
  for (const [date, rows] of days) {
    rows.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)) || Number(a.id) - Number(b.id));
    if (rows[0]?.event_type === 'departure') problems.add(`${date}:start:${rows[0].id}`);
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index - 1].event_type === rows[index].event_type) {
        problems.add(`${date}:${rows[index - 1].id}:${rows[index].id}:${rows[index].event_type}`);
      }
    }
  }
  return problems;
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
