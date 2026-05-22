export const DEFAULT_ACTIVE_WEEKDAYS = [1, 2, 3, 4, 5];

export function buildScheduleIndex(rows) {
  const index = { byStudentDay: new Map(), byClassDay: new Map() };
  for (const row of rows || []) {
    const lesson = normalizeScheduleLesson(row);
    if (!lesson) continue;
    const map = lesson.student_id ? index.byStudentDay : index.byClassDay;
    const ownerId = lesson.student_id || lesson.class_id;
    if (!ownerId) continue;
    const key = `${ownerId}|${lesson.date}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(lesson);
  }
  for (const map of [index.byStudentDay, index.byClassDay]) {
    for (const [key, lessons] of map.entries()) {
      map.set(key, dedupeAndMarkConflicts(lessons));
    }
  }
  return index;
}

export function normalizeScheduleLesson(row) {
  const date = dateOnly(row.lesson_date) || dateFromWeekStart(row.week_start, row.day_of_week);
  if (!date) return null;

  const fullStartsAt = `${date} ${normalizeTime(row.start_time)}`;
  const fullEndsAt = `${date} ${normalizeTime(row.end_time)}`;
  const fullStartMs = parseDateTimeMs(fullStartsAt);
  const fullEndMs = parseDateTimeMs(fullEndsAt);
  if (!Number.isFinite(fullStartMs) || !Number.isFinite(fullEndMs) || fullEndMs <= fullStartMs) {
    return null;
  }

  const slotPart = normalizeSlotPart(row.slot_part);
  const [effectiveStartMs, effectiveEndMs] = effectiveLessonBounds(fullStartMs, fullEndMs, slotPart);
  const effectiveStartsAt = formatSqlDateTime(effectiveStartMs);
  const effectiveEndsAt = formatSqlDateTime(effectiveEndMs);
  const subjectName = String(row.subject_name || '').trim() || 'Без предмета';
  const subjectKey = row.subject_id ? `id:${row.subject_id}` : `name:${subjectName.toLocaleLowerCase('ru')}`;
  const studentId = positiveString(row.student_id);
  const classId = positiveString(row.class_id);

  return {
    entry_ids: [String(row.entry_id || row.id || '')].filter(Boolean),
    week_id: row.week_id ? String(row.week_id) : '',
    week_version_id: row.week_version_id ? String(row.week_version_id) : '',
    date,
    slot_id: String(row.slot_id || ''),
    slot_number: Number(row.slot_number || 0),
    lesson_number: Number(row.slot_number || 0),
    day_of_week: Number(row.day_of_week || 0),
    class_id: classId,
    class_name: row.class_name || '',
    student_id: studentId,
    subject_id: row.subject_id ? String(row.subject_id) : '',
    subject_key: subjectKey,
    subject_name: subjectName,
    subject_type: row.subject_type || '',
    teacher_id: row.teacher_id ? String(row.teacher_id) : '',
    teacher_name: String(row.teacher_name || '').trim(),
    room_id: row.room_id ? String(row.room_id) : '',
    room_name: String(row.room_name || '').trim(),
    activity_type: row.activity_type || '',
    slot_part: slotPart,
    is_paid: Boolean(Number(row.is_paid || 0)),
    lesson_type_id: row.lesson_type_id ? String(row.lesson_type_id) : '',
    full_starts_at: fullStartsAt,
    full_ends_at: fullEndsAt,
    starts_at: effectiveStartsAt,
    ends_at: effectiveEndsAt,
    starts_ms: effectiveStartMs,
    ends_ms: effectiveEndMs,
    time_label: formatTimeRange(effectiveStartsAt, effectiveEndsAt),
    scope: studentId ? 'student' : 'class',
  };
}

export function lessonsForStudentDay(index, item, student, day) {
  const studentId = String(item.student_id || student.student_id || student.id || '');
  const classId = String(item.class_id || student.class_id || student.classId || '');
  const individual = index.byStudentDay.get(`${studentId}|${day}`) || [];
  const classLessons = index.byClassDay.get(`${classId}|${day}`) || [];
  const filteredClassLessons = classLessons.filter((classLesson) => (
    !individual.some((studentLesson) => sameSlotOverlap(studentLesson, classLesson))
  ));
  return dedupeAndMarkConflicts([...individual, ...filteredClassLessons]);
}

export function overlapMinutesForPeriod(period, lesson, range) {
  return overlapMinutesForInterval(period.starts_at, period.ends_at || range.end_at, lesson, range);
}

export function overlapMinutesForInterval(startsAt, endsAt, lesson, range = null) {
  const rangeStart = range?.start_at ? parseDateTimeMs(range.start_at) : Number.NEGATIVE_INFINITY;
  const rangeEnd = range?.end_at ? parseDateTimeMs(range.end_at) : Number.POSITIVE_INFINITY;
  const periodStartMs = Math.max(parseDateTimeMs(startsAt), rangeStart);
  const periodEndMs = Math.min(parseDateTimeMs(endsAt), rangeEnd);
  if (!Number.isFinite(periodStartMs) || !Number.isFinite(periodEndMs) || periodEndMs <= periodStartMs) return 0;
  const from = Math.max(periodStartMs, lesson.starts_ms);
  const to = Math.min(periodEndMs, lesson.ends_ms);
  return to > from ? (to - from) / 60_000 : 0;
}

export function dateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

export function isoWeekday(dateText) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function parseDateTimeMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

export function formatSqlDateTime(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

export function formatTimeRange(startsAt, endsAt) {
  return `${String(startsAt).slice(11, 16)}-${String(endsAt).slice(11, 16)}`;
}

export function formatDateLabel(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value || '');
}

export function formatMinutes(value) {
  const minutes = Math.round(Number(value || 0));
  return `${minutes} мин.`;
}

export function addDays(dateText, amount) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function dedupeAndMarkConflicts(lessons) {
  const bySubjectInterval = new Map();
  for (const lesson of lessons) {
    const key = [
      lesson.date,
      lesson.starts_at,
      lesson.ends_at,
      lesson.subject_key,
      lesson.slot_id,
    ].join('|');
    if (!bySubjectInterval.has(key)) {
      bySubjectInterval.set(key, { ...lesson, entry_ids: [...lesson.entry_ids] });
      continue;
    }
    const existing = bySubjectInterval.get(key);
    existing.entry_ids.push(...lesson.entry_ids);
    existing.teacher_name = joinDistinct(existing.teacher_name, lesson.teacher_name);
    existing.room_name = joinDistinct(existing.room_name, lesson.room_name);
    existing.scope = existing.scope === lesson.scope ? existing.scope : 'mixed';
  }

  const result = Array.from(bySubjectInterval.values()).sort(compareLessons);
  const byInterval = new Map();
  for (const lesson of result) {
    const key = `${lesson.date}|${lesson.starts_at}|${lesson.ends_at}|${lesson.slot_id}`;
    if (!byInterval.has(key)) byInterval.set(key, []);
    byInterval.get(key).push(lesson);
  }
  for (const group of byInterval.values()) {
    const subjectNames = [...new Set(group.map((lesson) => lesson.subject_name))];
    if (subjectNames.length <= 1) continue;
    for (const lesson of group) {
      lesson.has_conflict = true;
      lesson.conflict_subjects = subjectNames.join(', ');
    }
  }
  return result;
}

function compareLessons(a, b) {
  return (
    String(a.date).localeCompare(String(b.date)) ||
    Number(a.starts_ms || 0) - Number(b.starts_ms || 0) ||
    Number(a.lesson_number || 0) - Number(b.lesson_number || 0) ||
    String(a.subject_name || '').localeCompare(String(b.subject_name || ''), 'ru')
  );
}

function sameSlotOverlap(a, b) {
  return String(a.slot_id) === String(b.slot_id) && a.starts_ms < b.ends_ms && a.ends_ms > b.starts_ms;
}

function effectiveLessonBounds(startMs, endMs, slotPart) {
  const midpoint = startMs + Math.floor((endMs - startMs) / 2);
  if (slotPart === 'H1') return [startMs, midpoint];
  if (slotPart === 'H2') return [midpoint, endMs];
  return [startMs, endMs];
}

function normalizeSlotPart(value) {
  const part = String(value || 'FULL').trim().toUpperCase();
  return ['H1', 'H2', 'FULL'].includes(part) ? part : 'FULL';
}

function positiveString(value) {
  const text = String(value ?? '').trim();
  return text && text !== '0' && text !== 'null' ? text : '';
}

function dateFromWeekStart(weekStart, dayOfWeek) {
  const date = dateOnly(weekStart);
  const day = Number(dayOfWeek || 0);
  if (!date || day < 1) return '';
  return addDays(date, day - 1);
}

function normalizeTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return '00:00:00';
  return `${match[1].padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
}

function joinDistinct(left, right) {
  const values = new Set(String(left || '').split(', ').filter(Boolean));
  if (right) values.add(String(right));
  return Array.from(values).join(', ');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
