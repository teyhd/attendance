export const ATTENDANCE_CONFLICT_TYPES = {
  ARRIVAL_DURING_ABSENCE: 'arrival_during_absence',
};

export const ATTENDANCE_CONFLICT_RESOLUTIONS = {
  KEEP_PRESENCE: 'keep_presence',
  KEEP_ABSENCE: 'keep_absence',
  ABSENCE_ADJUSTED: 'absence_adjusted',
  ABSENCE_DELETED: 'absence_deleted',
  PRESENCE_CANCELLED: 'presence_cancelled',
};

export function isArrivalInsideAbsence(event, absence) {
  if (!event || !absence) return false;
  if (event.cancelled_at || absence.deleted_at) return false;
  if (String(event.event_type || '') !== 'arrival') return false;
  if (String(event.student_id || '') !== String(absence.student_id || '')) return false;

  const occurredAt = normalizeDateTime(event.occurred_at);
  const startsAt = normalizeDateTime(absence.starts_at);
  const endsAt = normalizeDateTime(absence.ends_at);
  return Boolean(occurredAt && startsAt && endsAt && occurredAt >= startsAt && occurredAt < endsAt);
}

export function conflictInterval(conflict) {
  const startsAt = normalizeDateTime(conflict?.occurred_at || conflict?.conflict_starts_at);
  const absenceEnd = normalizeDateTime(conflict?.ends_at || conflict?.conflict_ends_at);
  if (!startsAt || !absenceEnd || absenceEnd <= startsAt) return null;
  return { starts_at: startsAt, ends_at: absenceEnd };
}

export function normalizeConflictResolution(value) {
  const resolution = String(value || '').trim();
  if (![ATTENDANCE_CONFLICT_RESOLUTIONS.KEEP_PRESENCE, ATTENDANCE_CONFLICT_RESOLUTIONS.KEEP_ABSENCE].includes(resolution)) {
    return '';
  }
  return resolution;
}

export function conflictStatusLabel(conflict) {
  if (!conflict || conflict.status !== 'open') return 'Разрешён';
  return 'Конфликт отметок';
}

function normalizeDateTime(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  return match ? `${match[1]} ${match[2]}:${match[3] || '00'}` : '';
}
