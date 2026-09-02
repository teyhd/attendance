import { dateOnly, normalizeScheduleLesson, parseDateTimeMs } from './schedule-analytics.mjs';

export const ATTENDANCE_LESSON_SCHEMA_VERSION = 'attendance-lesson-resolution-v1';
export const ATTENDANCE_LESSON_ALGORITHM_VERSION = 'attendance-lesson-resolver-v1';
export const MAX_LESSON_RESOLUTION_REQUESTS = 50;
export const MAX_LESSON_RESOLUTION_STUDENTS = 1000;

const FINAL_STATUSES = new Set(['present', 'late', 'absent', 'sick', 'excused']);

export function normalizeLessonResolutionRequests(requests) {
  if (!Array.isArray(requests) || !requests.length) throw new TypeError('Не переданы уроки для разрешения');
  if (requests.length > MAX_LESSON_RESOLUTION_REQUESTS) throw new TypeError('Слишком много уроков в пакете');

  let studentCount = 0;
  const normalized = requests.map((request) => {
    const key = requiredText(request?.key, 100);
    const sourceLessonId = requiredText(request?.sourceLessonId, 64);
    const scheduleAnchorEntryId = positiveInteger(request?.scheduleAnchorEntryId);
    const lessonDate = validDate(request?.lessonDate);
    const classId = positiveInteger(request?.classId);
    const teacherId = positiveInteger(request?.teacherId);
    const sourceSubjectId = positiveInteger(request?.sourceSubjectId);
    const studentIds = uniquePositiveIntegers(request?.studentIds);
    studentCount += studentIds.length;
    if (!key || !sourceLessonId || !scheduleAnchorEntryId || !lessonDate || !classId || !teacherId
      || !sourceSubjectId || !studentIds.length) {
      throw new TypeError('Некорректный запрос разрешения урока');
    }
    return { key, sourceLessonId, scheduleAnchorEntryId, lessonDate, classId, teacherId, sourceSubjectId, studentIds };
  });
  if (studentCount > MAX_LESSON_RESOLUTION_STUDENTS) throw new TypeError('Слишком много учеников в пакете');
  if (new Set(normalized.map((request) => request.key)).size !== normalized.length) {
    throw new TypeError('Ключи запросов должны быть уникальными');
  }
  return normalized;
}

export function buildLessonResolutionContract({
  contexts = [],
  people = [],
  periods = [],
  presenceEvents = [],
  conflicts = [],
  lessonFacts = [],
  now = '',
} = {}) {
  const calculatedAt = new Date().toISOString();
  const nowMs = parseDateTimeMs(now || calculatedAt);
  const peopleById = new Map(people.map((person) => [String(person.person_id || person.student_id || person.id), person]));
  const periodsByStudent = groupBy(periods, (row) => row.student_id || row.person_id);
  const eventsByStudent = groupBy(presenceEvents, (row) => row.student_id || row.person_id);
  const conflictsByStudent = groupBy((conflicts || []).filter((row) => row.status === 'open'), (row) => row.student_id || row.person_id);
  const factsByStudent = groupBy((lessonFacts || []).filter((row) => !row.deleted_at), (row) => row.student_id || row.person_id);

  return {
    schemaVersion: ATTENDANCE_LESSON_SCHEMA_VERSION,
    algorithmVersion: ATTENDANCE_LESSON_ALGORITHM_VERSION,
    calculatedAt,
    items: contexts.map((context) => ({
      key: context.request.key,
      sourceLessonId: context.request.sourceLessonId,
      students: context.request.studentIds.map((studentId) => resolveStudent({
        context,
        studentId,
        person: peopleById.get(String(studentId)),
        periods: periodsByStudent.get(String(studentId)) || [],
        events: eventsByStudent.get(String(studentId)) || [],
        conflicts: conflictsByStudent.get(String(studentId)) || [],
        facts: factsByStudent.get(String(studentId)) || [],
        nowMs,
        calculatedAt,
      })),
    })),
  };
}

function resolveStudent({ context, studentId, person, periods, events, conflicts, facts, nowMs, calculatedAt }) {
  const common = {
    studentId,
    lateMinutes: 0,
    reasonCode: null,
    isFinal: false,
    matchedScheduleEntryId: null,
    scheduleVersionId: context.anchor?.week_version_id ? Number(context.anchor.week_version_id) : null,
    qualityIssues: [],
    algorithmVersion: ATTENDANCE_LESSON_ALGORITHM_VERSION,
    calculatedAt,
  };
  if (context.anchorError) return unavailable(common, context.anchorError);
  if (!person || Number(person.user_type) !== 1) return unavailable(common, 'inactive_student');
  if (Number(person.class_id) !== context.request.classId) return unavailable(common, 'student_class_mismatch');

  const candidateRows = (context.scheduleRows || []).filter((row) => Number(row.resolved_student_id || row.student_id) === studentId);
  const lessons = candidateRows.map(normalizeScheduleLesson).filter(Boolean);
  if (!lessons.length) return unavailable(common, 'student_not_in_lesson');
  const uniqueIntervals = new Set(lessons.map((lesson) => `${lesson.starts_at}|${lesson.ends_at}|${lesson.subject_id}|${lesson.teacher_id}`));
  if (uniqueIntervals.size > 1) return conflict(common, ['ambiguous_schedule_match']);

  const lesson = preferStudentSpecificLesson(lessons);
  common.matchedScheduleEntryId = numericOrText(lesson.entry_ids?.[0]);
  common.scheduleVersionId = numericOrText(lesson.week_version_id) ?? common.scheduleVersionId;
  if (dateOnly(lesson.date) !== context.request.lessonDate) return unavailable(common, 'lesson_date_mismatch');
  if (nowMs < lesson.starts_ms) return { ...common, resolution: 'not_started', status: null };

  const effectiveEndMs = Math.min(lesson.ends_ms, nowMs);
  const scheduledMinutes = minutes(lesson.starts_ms, effectiveEndMs);
  const isEnded = nowMs >= lesson.ends_ms;
  const relevantConflicts = conflicts.filter((row) => overlapsConflict(row, lesson));
  const dayEvents = events.filter((row) => dateOnly(row.attendance_date || row.occurred_at) === lesson.date);
  const paired = presenceIntervals(dayEvents, lesson, nowMs);
  const physical = overlapSummary(paired.intervals, lesson.starts_ms, effectiveEndMs);
  const absences = absenceOverlaps(periods, lesson, effectiveEndMs);
  const absenceMinutes = Math.min(scheduledMinutes, absences.reduce((sum, row) => sum + row.minutes, 0));
  const matchingFacts = exactLessonFacts(facts, context, lesson);
  const fact = matchingFacts.toSorted(compareFactVersion).at(-1) || null;
  const qualityIssues = [];
  if (paired.unmatched) qualityIssues.push('unmatched_presence_event');
  if (matchingFacts.length > 1 && new Set(matchingFacts.map((row) => row.status)).size > 1) {
    qualityIssues.push('contradictory_lesson_facts');
  }
  if (lesson.has_conflict) qualityIssues.push('schedule_conflict');
  if (relevantConflicts.length) qualityIssues.push('attendance_conflict');
  if (qualityIssues.some((code) => ['contradictory_lesson_facts', 'schedule_conflict', 'attendance_conflict'].includes(code))) {
    return conflict(common, qualityIssues);
  }

  if (fact) {
    const contradictsPresence = ['absent', 'sick', 'excused'].includes(fact.status) && physical.minutes > 0;
    const contradictsAbsence = ['present', 'late'].includes(fact.status) && absenceMinutes > 0;
    if (contradictsPresence || contradictsAbsence) return conflict(common, [...qualityIssues, 'lesson_fact_source_conflict']);
    const factStatus = FINAL_STATUSES.has(fact.status) ? fact.status : null;
    if (!factStatus) return unavailable(common, 'unsupported_lesson_fact');
    return {
      ...common,
      resolution: isEnded ? 'resolved' : 'provisional',
      status: factStatus,
      lateMinutes: factStatus === 'late' ? Math.max(0, Number(fact.late_minutes || 0)) : 0,
      reasonCode: reasonForFact(factStatus, absences),
      isFinal: isEnded,
      qualityIssues,
    };
  }

  if (physical.minutes > 0 && absenceMinutes > 0) {
    return conflict(common, [...qualityIssues, 'presence_absence_overlap']);
  }

  let status = null;
  let lateMinutes = 0;
  let reasonCode = null;
  if (absenceMinutes >= scheduledMinutes - 0.5 && scheduledMinutes > 0) {
    const reason = dominantAbsence(absences);
    status = reason?.code === 'illness' ? 'sick' : reason?.isExcused ? 'excused' : 'absent';
    reasonCode = reason?.code || 'without_reason';
  } else if (physical.minutes >= scheduledMinutes - 0.5 && scheduledMinutes > 0) {
    lateMinutes = Math.max(0, Math.ceil((physical.firstStart - lesson.starts_ms) / 60_000));
    status = lateMinutes > 0 ? 'late' : 'present';
  } else if (physical.minutes > 0 || absenceMinutes > 0) {
    if (!isEnded) {
      status = physical.minutes > 0 ? 'present' : dominantAbsenceStatus(absences);
    } else {
      return {
        ...common,
        resolution: 'partial',
        status: null,
        reasonCode: dominantAbsence(absences)?.code || null,
        qualityIssues: [...qualityIssues, 'partial_lesson_coverage'],
      };
    }
  } else {
    status = 'absent';
    reasonCode = 'without_reason';
  }

  return {
    ...common,
    resolution: isEnded ? 'resolved' : 'provisional',
    status,
    lateMinutes,
    reasonCode,
    isFinal: isEnded,
    qualityIssues,
  };
}

function unavailable(common, code) {
  return { ...common, resolution: 'unavailable', status: null, qualityIssues: [code] };
}

function conflict(common, qualityIssues) {
  return { ...common, resolution: 'conflict', status: null, qualityIssues: Array.from(new Set(qualityIssues)) };
}

function preferStudentSpecificLesson(lessons) {
  return lessons.find((lesson) => lesson.scope === 'student') || lessons[0];
}

function exactLessonFacts(facts, context, lesson) {
  const entryIds = new Set((lesson.entry_ids || []).map(String));
  return facts.filter((fact) => (
    String(fact.lesson_id || '') === String(context.request.sourceLessonId)
    || (fact.schedule_entry_id && entryIds.has(String(fact.schedule_entry_id)))
  ));
}

function compareFactVersion(a, b) {
  return Number(a.source_version || 0) - Number(b.source_version || 0) || Number(a.id || 0) - Number(b.id || 0);
}

function reasonForFact(status, absences) {
  if (status === 'sick') return 'illness';
  if (status === 'excused') return dominantAbsence(absences)?.code || 'excused';
  if (status === 'absent') return dominantAbsence(absences)?.code || 'without_reason';
  return null;
}

function dominantAbsenceStatus(absences) {
  const reason = dominantAbsence(absences);
  return reason?.code === 'illness' ? 'sick' : reason?.isExcused ? 'excused' : 'absent';
}

function dominantAbsence(absences) {
  return [...absences].sort((a, b) => b.minutes - a.minutes)[0] || null;
}

function absenceOverlaps(periods, lesson, effectiveEndMs) {
  const result = [];
  for (const period of periods) {
    const start = Math.max(parseDateTimeMs(period.starts_at), lesson.starts_ms);
    const end = Math.min(parseDateTimeMs(period.ends_at), effectiveEndMs);
    const value = minutes(start, end);
    if (value <= 0) continue;
    result.push({ code: period.reason_code || 'other', isExcused: Boolean(Number(period.is_excused)), minutes: value });
  }
  return result;
}

function presenceIntervals(events, lesson, nowMs) {
  const sorted = [...events].filter((event) => !event.cancelled_at).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  const intervals = [];
  let arrival = null;
  let unmatched = 0;
  for (const event of sorted) {
    const at = parseDateTimeMs(event.occurred_at);
    if (!Number.isFinite(at) || at > nowMs) continue;
    if (event.event_type === 'arrival') {
      if (arrival != null) unmatched += 1;
      arrival = at;
    } else if (event.event_type === 'departure' && arrival != null && at > arrival) {
      intervals.push({ start: arrival, end: at });
      arrival = null;
    } else {
      unmatched += 1;
    }
  }
  if (arrival != null) intervals.push({ start: arrival, end: Math.min(nowMs, lesson.ends_ms) });
  return { intervals, unmatched };
}

function overlapSummary(intervals, start, end) {
  const overlaps = intervals
    .map((interval) => ({ start: Math.max(start, interval.start), end: Math.min(end, interval.end) }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  return {
    minutes: overlaps.reduce((sum, interval) => sum + minutes(interval.start, interval.end), 0),
    firstStart: overlaps[0]?.start ?? Number.NaN,
  };
}

function overlapsConflict(row, lesson) {
  const start = parseDateTimeMs(row.conflict_starts_at || row.occurred_at);
  const end = parseDateTimeMs(row.conflict_ends_at || row.occurred_at);
  return Number.isFinite(start) && start < lesson.ends_ms && (Number.isFinite(end) ? end : start + 1) > lesson.starts_ms;
}

function groupBy(rows, keyOf) {
  const result = new Map();
  for (const row of rows || []) {
    const key = String(keyOf(row) || '');
    if (!key) continue;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

function uniquePositiveIntegers(values) {
  if (!Array.isArray(values)) return [];
  const result = Array.from(new Set(values.map(positiveInteger).filter(Boolean)));
  return result.length === values.length ? result : [];
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function requiredText(value, maxLength) {
  const text = String(value || '').trim();
  return text && text.length <= maxLength ? text : '';
}

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : '';
}

function minutes(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 60_000 : 0;
}

function numericOrText(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : String(value);
}
