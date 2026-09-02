import {
  DEFAULT_ACTIVE_WEEKDAYS,
  addDays,
  buildScheduleIndex,
  dateOnly,
  isoWeekday,
  lessonsForStudentDay,
  parseDateTimeMs,
} from './schedule-analytics.mjs';

export const ATTENDANCE_ANALYTICS_SCHEMA_VERSION = 'attendance-analytics-v2';
export const ATTENDANCE_ANALYTICS_ALGORITHM_VERSION = 'attendance-canonical-v1';
export const MAX_ANALYTICS_RANGE_DAYS = 366;
export const MAX_ANALYTICS_ITEMS = 3000;
export const LATE_THRESHOLD_MINUTES = 0;

export function buildAnalyticsRange(from, to) {
  const start = validDate(from);
  const end = validDate(to);
  if (!start || !end) throw new TypeError('Некорректный период');
  if (start > end) throw new TypeError('Начало периода позже окончания');
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_ANALYTICS_RANGE_DAYS) throw new TypeError('Период слишком большой');
  }
  return {
    from: start,
    to: end,
    start_date: start,
    end_date: end,
    start_at: `${start} 00:00:00`,
    end_at: `${end} 23:59:59`,
    days,
    days_count: days.length,
    timezone: 'Europe/Moscow',
  };
}

export function normalizeAnalyticsItems(items) {
  if (!Array.isArray(items) || !items.length) throw new TypeError('Не переданы объекты аналитики');
  if (items.length > MAX_ANALYTICS_ITEMS) throw new TypeError('Слишком много объектов аналитики');
  const normalized = items.map((item) => ({
    key: String(item?.key || '').trim(),
    personId: positiveInteger(item?.personId ?? item?.studentId),
    personType: item?.personType === 'employee' ? 'employee' : 'student',
    subjectId: optionalPositiveInteger(item?.subjectId),
    teacherId: optionalPositiveInteger(item?.teacherId),
  }));
  if (normalized.some((item) => !item.key || !item.personId)) throw new TypeError('Некорректный объект аналитики');
  if (new Set(normalized.map((item) => item.key)).size !== normalized.length) {
    throw new TypeError('Ключи объектов аналитики должны быть уникальными');
  }
  return normalized;
}

export function buildAttendanceAnalyticsContract({
  range,
  items = [],
  people = [],
  periods = [],
  presenceEvents = [],
  conflicts = [],
  scheduleRows = [],
  publishedSchoolDays = [],
  activeWeekdays = DEFAULT_ACTIVE_WEEKDAYS,
  lessonFacts = [],
  now = '',
} = {}) {
  if (!range) throw new TypeError('Не передан период');
  const calculatedAt = new Date().toISOString();
  const nowMs = parseDateTimeMs(now || range.end_at);
  const peopleById = new Map(people.map((person) => [String(person.person_id || person.student_id || person.id), person]));
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const published = new Set(publishedSchoolDays.map(dateOnly).filter(Boolean));
  const active = new Set((activeWeekdays || DEFAULT_ACTIVE_WEEKDAYS).map(Number));
  const periodsByPerson = groupBy(periods, (row) => String(row.student_id || row.person_id || ''));
  const eventsByPersonDay = groupBy(presenceEvents, (row) => `${row.student_id || row.person_id || ''}|${dateOnly(row.attendance_date || row.occurred_at)}`);
  const conflictsByPersonDay = groupBy((conflicts || []).filter((row) => row.status === 'open'), (row) => `${row.student_id || row.person_id || ''}|${dateOnly(row.occurred_at || row.conflict_starts_at)}`);
  const factsByPerson = groupBy((lessonFacts || []).filter((row) => !row.deleted_at), (row) => String(row.student_id || row.person_id || ''));
  const computed = new Map();

  const responseItems = items.map((request) => {
    const person = peopleById.get(String(request.personId));
    if (!person) return unavailableItem(request, range, calculatedAt, 'person_not_found');
    const actualPersonType = Number(person.user_type) === 1 ? 'student' : 'employee';
    if (request.personType !== actualPersonType) {
      return unavailableItem(request, range, calculatedAt, 'person_type_mismatch');
    }
    const cacheKey = `${request.personType}:${request.personId}`;
    if (!computed.has(cacheKey)) {
      computed.set(cacheKey, request.personType === 'employee'
        ? buildEmployeeAnalytics({ request, person, range, periods: periodsByPerson.get(String(request.personId)) || [], eventsByPersonDay, conflictsByPersonDay, nowMs })
        : buildStudentAnalytics({ request, person, range, scheduleIndex, published, active, periods: periodsByPerson.get(String(request.personId)) || [], eventsByPersonDay, conflictsByPersonDay, lessonFacts: factsByPerson.get(String(request.personId)) || [], nowMs }));
    }
    return scopeResult(computed.get(cacheKey), request, range, calculatedAt);
  });

  return {
    schemaVersion: ATTENDANCE_ANALYTICS_SCHEMA_VERSION,
    algorithmVersion: ATTENDANCE_ANALYTICS_ALGORITHM_VERSION,
    calculatedAt,
    period: publicPeriod(range),
    items: responseItems,
  };
}

function buildStudentAnalytics({ request, person, range, scheduleIndex, published, active, periods, eventsByPersonDay, conflictsByPersonDay, lessonFacts, nowMs }) {
  const lessons = [];
  const daily = new Map();
  const reasons = new Map();
  const subjects = new Map();
  const expectedDates = range.days.filter((day) => active.has(isoWeekday(day)) && parseDateTimeMs(`${day} 00:00:00`) <= nowMs);
  const missingScheduleDates = expectedDates.filter((day) => !published.has(day));
  let unmatchedEvents = 0;
  let ambiguousLessonFacts = 0;

  for (const day of range.days) {
    const personDayKey = `${request.personId}|${day}`;
    const scheduled = published.has(day) ? lessonsForStudentDay(scheduleIndex, person, person, day) : [];
    const pastLessons = scheduled.filter((lesson) => lesson.starts_ms <= nowMs);
    const dayEvents = eventsByPersonDay.get(personDayKey) || [];
    const paired = presenceIntervals(dayEvents, pastLessons, nowMs);
    unmatchedEvents += paired.unmatched;
    const dayConflicts = conflictsByPersonDay.get(personDayKey) || [];
    const dayFacts = lessonFacts.filter((fact) => dateOnly(fact.lesson_date) === day);
    const firstLesson = pastLessons[0];
    const firstArrival = firstArrivalMs(dayEvents);
    const physicalLateMinutes = firstLesson && Number.isFinite(firstArrival)
      ? Math.max(0, Math.ceil((firstArrival - firstLesson.starts_ms) / 60_000))
      : 0;

    for (const lesson of pastLessons) {
      const scheduledMinutes = minutes(lesson.starts_ms, Math.min(lesson.ends_ms, nowMs));
      if (scheduledMinutes <= 0) continue;
      const matchingFacts = matchLessonFacts(dayFacts, lesson);
      if (matchingFacts.length > 1) ambiguousLessonFacts += 1;
      const fact = matchingFacts.toSorted(compareFactVersion).at(-1) || null;
      const conflict = Boolean(lesson.has_conflict || dayConflicts.length);
      const reasonOverlaps = absenceOverlaps(periods, lesson, nowMs);
      const physicalMinutes = overlapTotal(paired.intervals, lesson.starts_ms, Math.min(lesson.ends_ms, nowMs));
      const classification = classifyLesson({
        lesson,
        fact,
        conflict,
        scheduledMinutes,
        physicalMinutes,
        reasonOverlaps,
        physicalLateMinutes: lesson === firstLesson && physicalLateMinutes > LATE_THRESHOLD_MINUTES ? physicalLateMinutes : 0,
      });
      const row = {
        date: day,
        scheduleEntryIds: lesson.entry_ids || [],
        subjectId: numericOrNull(lesson.subject_id),
        subjectName: lesson.subject_name || '',
        teacherIds: (lesson.teacher_ids || []).map(Number).filter(Number.isInteger),
        scheduledMinutes,
        ambiguousLessonFact: matchingFacts.length > 1,
        ...classification,
      };
      lessons.push(row);
      addMetrics(ensureDaily(daily, day), row);
      addMetrics(ensureSubject(subjects, row), row);
      for (const reason of classification.reasonMinutes) addReason(reasons, reason);
    }
  }

  const summary = aggregateLessons(lessons);
  const qualityIssues = [];
  if (missingScheduleDates.length) qualityIssues.push({ code: 'schedule_gap', count: missingScheduleDates.length });
  if (summary.conflictMinutes) qualityIssues.push({ code: 'attendance_conflict', minutes: summary.conflictMinutes });
  if (unmatchedEvents) qualityIssues.push({ code: 'unmatched_presence_event', count: unmatchedEvents });
  if (ambiguousLessonFacts) qualityIssues.push({ code: 'ambiguous_lesson_fact', count: ambiguousLessonFacts });
  const state = missingScheduleDates.length || summary.conflictMinutes || ambiguousLessonFacts || unmatchedEvents
    ? 'partial'
    : summary.scheduledMinutes > 0 ? 'complete' : 'no_schedule';
  finalizeSummary(summary, state);
  return {
    person: personPayload(person, request.personId, 'student'),
    basis: 'scheduled_minutes',
    state,
    _lessons: lessons,
    summary,
    subjects: Array.from(subjects.values()).map((row) => finalizeBucket(row, state)),
    daily: Array.from(daily.values()).map((row) => finalizeBucket(row, state)),
    absenceByReason: Array.from(reasons.values()).sort((a, b) => b.minutes - a.minutes),
    quality: {
      state,
      expectedDays: expectedDates.length,
      coveredDays: expectedDates.length - missingScheduleDates.length,
      missingScheduleDates,
      issues: qualityIssues,
    },
  };
}

function buildEmployeeAnalytics({ request, person, range, periods, eventsByPersonDay, conflictsByPersonDay, nowMs }) {
  const daily = [];
  const reasons = new Map();
  let onsiteMinutes = 0;
  let presentDays = 0;
  let unmatchedEvents = 0;
  let conflictDays = 0;
  for (const day of range.days) {
    const key = `${request.personId}|${day}`;
    const dayEvents = eventsByPersonDay.get(key) || [];
    const paired = observedEmployeeIntervals(dayEvents, day, nowMs);
    const dayOnsite = intervalMinutes(paired.intervals);
    const dayPeriods = absenceOverlapsDay(periods, day, nowMs);
    const dayConflicts = (conflictsByPersonDay.get(key) || []).length;
    onsiteMinutes += dayOnsite;
    if (dayEvents.some((event) => event.event_type === 'arrival' && !event.cancelled_at)) presentDays += 1;
    unmatchedEvents += paired.unmatched;
    if (dayConflicts) conflictDays += 1;
    for (const reason of dayPeriods) addReason(reasons, reason);
    if (dayOnsite || dayPeriods.length || paired.unmatched || dayConflicts) {
      daily.push({
        date: day,
        onsiteMinutes: dayOnsite,
        absenceMinutes: dayPeriods.reduce((sum, item) => sum + item.minutes, 0),
        firstArrivalAt: firstEventAt(dayEvents, 'arrival'),
        lastDepartureAt: lastEventAt(dayEvents, 'departure'),
        unmatchedEvents: paired.unmatched,
        conflicts: dayConflicts,
      });
    }
  }
  const issues = [];
  if (unmatchedEvents) issues.push({ code: 'unmatched_presence_event', count: unmatchedEvents });
  if (conflictDays) issues.push({ code: 'attendance_conflict', count: conflictDays });
  return {
    person: personPayload(person, request.personId, 'employee'),
    basis: 'observed_intervals',
    state: issues.length ? 'partial' : 'complete',
    summary: {
      expectedMinutes: null,
      scheduledMinutes: null,
      attendedMinutes: null,
      missedMinutes: null,
      attendancePercent: null,
      lateDays: null,
      lateMinutes: null,
      onsiteMinutes,
      presentDays,
      absenceMinutes: Array.from(reasons.values()).reduce((sum, item) => sum + item.minutes, 0),
    },
    subjects: [],
    daily,
    absenceByReason: Array.from(reasons.values()).sort((a, b) => b.minutes - a.minutes),
    quality: { state: issues.length ? 'partial' : 'complete', expectedDays: null, coveredDays: null, missingScheduleDates: [], issues },
  };
}

function classifyLesson({ lesson, fact, conflict, scheduledMinutes, physicalMinutes, reasonOverlaps, physicalLateMinutes }) {
  const reasonMinutes = [];
  if (conflict) return lessonMetrics(scheduledMinutes, 0, 0, 0, scheduledMinutes, 0, reasonMinutes, 'conflict');
  const absenceMinutes = Math.min(scheduledMinutes, reasonOverlaps.reduce((sum, item) => sum + item.minutes, 0));
  if (fact) {
    if (['present', 'late'].includes(fact.status) && absenceMinutes > 0) {
      return lessonMetrics(scheduledMinutes, 0, 0, 0, scheduledMinutes, 0, reasonMinutes, 'conflict');
    }
    if (['absent', 'sick', 'excused'].includes(fact.status) && physicalMinutes > LATE_THRESHOLD_MINUTES) {
      return lessonMetrics(scheduledMinutes, 0, 0, 0, scheduledMinutes, 0, reasonMinutes, 'conflict');
    }
    if (fact.status === 'present') return lessonMetrics(scheduledMinutes, scheduledMinutes, 0, 0, 0, 0, reasonMinutes, 'present');
    if (fact.status === 'late') {
      const late = Math.min(scheduledMinutes, Math.max(0, Number(fact.late_minutes || physicalLateMinutes || 0)));
      return lessonMetrics(scheduledMinutes, scheduledMinutes - late, late, 0, 0, late, reasonMinutes, 'late');
    }
    const synthetic = fact.status === 'sick'
      ? { code: 'illness', name: 'Болезнь', isExcused: true, minutes: scheduledMinutes }
      : fact.status === 'excused'
        ? { code: 'excused', name: 'Уважительная причина', isExcused: true, minutes: scheduledMinutes }
        : { code: 'without_reason', name: 'Без причины', isExcused: false, minutes: scheduledMinutes };
    const selected = reasonOverlaps.length ? scaleReasons(reasonOverlaps, scheduledMinutes) : [];
    const classified = selected.reduce((sum, reason) => sum + Number(reason.minutes || 0), 0);
    if (classified < scheduledMinutes) selected.push({ ...synthetic, minutes: round2(scheduledMinutes - classified) });
    reasonMinutes.push(...selected);
    return lessonMetrics(scheduledMinutes, 0, scheduledMinutes, scheduledMinutes, 0, 0, reasonMinutes, 'absent');
  }
  const scaledReasons = scaleReasons(reasonOverlaps, absenceMinutes);
  reasonMinutes.push(...scaledReasons);
  const attendedMinutes = Math.min(scheduledMinutes, Math.max(0, physicalMinutes - absenceMinutes));
  const missedMinutes = Math.max(0, scheduledMinutes - attendedMinutes);
  const noMarkMinutes = Math.max(0, missedMinutes - absenceMinutes);
  if (noMarkMinutes > 0) reasonMinutes.push({ code: 'no_mark', name: 'Нет отметки', isExcused: false, minutes: noMarkMinutes });
  const lateMinutes = physicalLateMinutes > LATE_THRESHOLD_MINUTES ? Math.min(missedMinutes, physicalLateMinutes) : 0;
  const status = attendedMinutes >= scheduledMinutes ? 'present' : attendedMinutes > 0 ? 'partial' : 'absent';
  return lessonMetrics(scheduledMinutes, attendedMinutes, missedMinutes, absenceMinutes, 0, lateMinutes, reasonMinutes, status, noMarkMinutes);
}

function lessonMetrics(scheduledMinutes, attendedMinutes, missedMinutes, confirmedAbsenceMinutes, conflictMinutes, lateMinutes, reasonMinutes, status, noMarkMinutes = 0) {
  return { attendedMinutes, missedMinutes, confirmedAbsenceMinutes, noMarkMinutes, conflictMinutes, lateMinutes, lateLessons: lateMinutes > 0 ? 1 : 0, missedLessons: missedMinutes > 15 ? 1 : 0, reasonMinutes, status };
}

function scopeResult(base, request, range, calculatedAt) {
  let summary = base.summary;
  let subjects = base.subjects;
  let daily = base.daily;
  let absenceByReason = base.absenceByReason;
  let quality = base.quality;
  let state = base.state;
  if ((request.subjectId || request.teacherId) && Array.isArray(base._lessons)) {
    const scopedRows = base._lessons.filter((row) => (
      (!request.subjectId || Number(row.subjectId) === request.subjectId)
      && (!request.teacherId || row.teacherIds.includes(request.teacherId))
    ));
    quality = scopedQuality(base.quality, scopedRows);
    state = quality.state;
    if (!scopedRows.length) {
      summary = emptyLessonSummary();
      summary.attendancePercent = null;
      subjects = [];
      daily = [];
      absenceByReason = [];
    } else {
      const scoped = aggregateScopedLessons(scopedRows, state);
      summary = scoped.summary;
      subjects = scoped.subjects;
      daily = scoped.daily;
      absenceByReason = scoped.absenceByReason;
    }
  }
  return {
    key: request.key,
    state,
    person: base.person,
    basis: base.basis,
    period: publicPeriod(range),
    summary,
    subjects,
    daily,
    absenceByReason,
    quality,
    algorithmVersion: ATTENDANCE_ANALYTICS_ALGORITHM_VERSION,
    calculatedAt,
  };
}

function scopedQuality(baseQuality, rows) {
  const issues = (baseQuality?.issues || []).filter((issue) => ['schedule_gap', 'unmatched_presence_event'].includes(issue.code));
  const conflictMinutes = rows.reduce((sum, row) => sum + Number(row.conflictMinutes || 0), 0);
  const ambiguousFacts = rows.filter((row) => row.ambiguousLessonFact).length;
  if (conflictMinutes > 0) issues.push({ code: 'attendance_conflict', minutes: conflictMinutes });
  if (ambiguousFacts > 0) issues.push({ code: 'ambiguous_lesson_fact', count: ambiguousFacts });
  const state = issues.length ? 'partial' : rows.length ? 'complete' : 'no_schedule';
  return {
    state,
    expectedDays: baseQuality?.expectedDays ?? 0,
    coveredDays: baseQuality?.coveredDays ?? 0,
    missingScheduleDates: baseQuality?.missingScheduleDates || [],
    issues,
  };
}

function aggregateScopedLessons(rows, state) {
  const summary = aggregateLessons(rows);
  const daily = new Map();
  const subjects = new Map();
  const reasons = new Map();
  for (const row of rows) {
    addMetrics(ensureDaily(daily, row.date), row);
    addMetrics(ensureSubject(subjects, row), row);
    for (const reason of row.reasonMinutes || []) addReason(reasons, reason);
  }
  finalizeSummary(summary, state);
  return {
    summary,
    subjects: Array.from(subjects.values()).map((row) => finalizeBucket(row, state)),
    daily: Array.from(daily.values()).map((row) => finalizeBucket(row, state)),
    absenceByReason: Array.from(reasons.values()).sort((a, b) => b.minutes - a.minutes),
  };
}

function unavailableItem(request, range, calculatedAt, reason) {
  return { key: request.key, state: 'unavailable', person: { id: request.personId, type: request.personType }, basis: request.personType === 'employee' ? 'observed_intervals' : 'scheduled_minutes', period: publicPeriod(range), summary: emptyLessonSummary(), subjects: [], daily: [], absenceByReason: [], quality: { state: 'unavailable', expectedDays: 0, coveredDays: 0, missingScheduleDates: [], issues: [{ code: reason }] }, algorithmVersion: ATTENDANCE_ANALYTICS_ALGORITHM_VERSION, calculatedAt };
}

function matchLessonFacts(facts, lesson) {
  const entryIds = new Set((lesson.entry_ids || []).map(String));
  const exact = facts.filter((fact) => fact.schedule_entry_id && entryIds.has(String(fact.schedule_entry_id)));
  if (exact.length) return exact;
  return facts.filter((fact) => String(fact.subject_id || '') === String(lesson.subject_id || ''));
}

function compareFactVersion(a, b) {
  return Number(a.source_version || 0) - Number(b.source_version || 0) || Number(a.id || 0) - Number(b.id || 0);
}

function absenceOverlaps(periods, lesson, nowMs) {
  const rows = [];
  for (const period of periods) {
    const start = Math.max(parseDateTimeMs(period.starts_at), lesson.starts_ms);
    const end = Math.min(parseDateTimeMs(period.ends_at), lesson.ends_ms, nowMs);
    const value = minutes(start, end);
    if (value <= 0) continue;
    rows.push({ code: period.reason_code || 'other', name: period.reason_name || period.reason_code || 'Другое', isExcused: Boolean(Number(period.is_excused)), minutes: value });
  }
  return rows;
}

function absenceOverlapsDay(periods, day, nowMs) {
  const startDay = parseDateTimeMs(`${day} 00:00:00`);
  const endDay = Math.min(parseDateTimeMs(`${day} 23:59:59`), nowMs);
  const rows = [];
  for (const period of periods) {
    const value = minutes(Math.max(startDay, parseDateTimeMs(period.starts_at)), Math.min(endDay, parseDateTimeMs(period.ends_at)));
    if (value > 0) rows.push({ code: period.reason_code || 'other', name: period.reason_name || period.reason_code || 'Другое', isExcused: Boolean(Number(period.is_excused)), minutes: value });
  }
  return rows;
}

function presenceIntervals(events, lessons, nowMs) {
  const sorted = [...events].filter((event) => !event.cancelled_at).sort(compareEvents);
  const intervals = [];
  let arrival = null;
  let unmatched = 0;
  for (const event of sorted) {
    const at = parseDateTimeMs(event.occurred_at);
    if (!Number.isFinite(at) || at > nowMs) continue;
    if (event.event_type === 'arrival') {
      if (arrival != null) unmatched += 1;
      arrival = at;
    } else if (arrival != null && at > arrival) {
      intervals.push({ start: arrival, end: at });
      arrival = null;
    } else unmatched += 1;
  }
  if (arrival != null) {
    const lastLessonEnd = Math.min(nowMs, Math.max(arrival, ...lessons.map((lesson) => lesson.ends_ms)));
    if (lastLessonEnd > arrival) intervals.push({ start: arrival, end: lastLessonEnd });
    unmatched += 1;
  }
  return { intervals, unmatched };
}

function observedEmployeeIntervals(events, day, nowMs) {
  const sorted = [...events].filter((event) => !event.cancelled_at).sort(compareEvents);
  const intervals = [];
  let arrival = null;
  let unmatched = 0;
  for (const event of sorted) {
    const at = parseDateTimeMs(event.occurred_at);
    if (!Number.isFinite(at) || at > nowMs) continue;
    if (event.event_type === 'arrival') {
      if (arrival != null) unmatched += 1;
      arrival = at;
    } else if (arrival != null && at > arrival) {
      intervals.push({ start: arrival, end: at });
      arrival = null;
    } else unmatched += 1;
  }
  if (arrival != null) {
    if (day === dateOnly(new Date(nowMs).toISOString())) intervals.push({ start: arrival, end: nowMs });
    else unmatched += 1;
  }
  return { intervals, unmatched };
}

function aggregateLessons(rows) {
  const summary = emptyLessonSummary();
  for (const row of rows) addMetrics(summary, row);
  return summary;
}

function addMetrics(target, row) {
  target.scheduledMinutes += Number(row.scheduledMinutes || 0);
  target.attendedMinutes += Number(row.attendedMinutes || 0);
  target.missedMinutes += Number(row.missedMinutes || 0);
  target.confirmedAbsenceMinutes += Number(row.confirmedAbsenceMinutes || 0);
  target.noMarkMinutes += Number(row.noMarkMinutes || 0);
  target.conflictMinutes += Number(row.conflictMinutes || 0);
  target.lateMinutes += Number(row.lateMinutes || 0);
  target.lateLessons += Number(row.lateLessons || 0);
  target.missedLessons += Number(row.missedLessons || 0);
  target.scheduledLessons += 1;
  const reasonCodes = new Set((row.reasonMinutes || []).filter((reason) => Number(reason.minutes || 0) > 0).map((reason) => reason.code));
  const hasExcused = (row.reasonMinutes || []).some((reason) => reason.isExcused && Number(reason.minutes || 0) > 0);
  const hasUnexcused = (row.reasonMinutes || []).some((reason) => (
    !reason.isExcused
    && !['without_reason', 'no_mark'].includes(reason.code)
    && Number(reason.minutes || 0) > 0
  ));
  if (reasonCodes.has('illness')) target.sickLessons += 1;
  if (hasExcused && !reasonCodes.has('illness')) target.excusedLessons += 1;
  if (hasUnexcused) target.unexcusedLessons += 1;
  if (reasonCodes.has('without_reason') || reasonCodes.has('no_mark')) target.withoutReasonLessons += 1;
}

function finalizeSummary(summary, state) {
  const denominator = Math.max(0, summary.scheduledMinutes - summary.conflictMinutes);
  summary.attendancePercent = state === 'complete' && denominator > 0 ? round2(summary.attendedMinutes / denominator * 100) : null;
  summary.absenceMinutes = summary.missedMinutes;
  return summary;
}

function finalizeBucket(bucket, state) {
  const result = { ...bucket };
  finalizeSummary(result, state);
  return result;
}

function emptyLessonSummary() {
  return { scheduledMinutes: 0, attendedMinutes: 0, missedMinutes: 0, absenceMinutes: 0, confirmedAbsenceMinutes: 0, noMarkMinutes: 0, conflictMinutes: 0, lateMinutes: 0, lateLessons: 0, missedLessons: 0, scheduledLessons: 0, sickLessons: 0, excusedLessons: 0, unexcusedLessons: 0, withoutReasonLessons: 0, attendancePercent: null };
}

function ensureDaily(map, date) {
  if (!map.has(date)) map.set(date, { date, ...emptyLessonSummary() });
  return map.get(date);
}

function ensureSubject(map, row) {
  const key = String(row.subjectId || row.subjectName || 'unknown');
  if (!map.has(key)) map.set(key, { subjectId: row.subjectId, subjectName: row.subjectName, ...emptyLessonSummary() });
  return map.get(key);
}

function addReason(map, reason) {
  const key = String(reason.code || 'other');
  if (!map.has(key)) map.set(key, { code: key, name: reason.name || key, isExcused: Boolean(reason.isExcused), minutes: 0 });
  map.get(key).minutes += Number(reason.minutes || 0);
}

function scaleReasons(reasons, targetMinutes) {
  const total = reasons.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
  if (!total || !targetMinutes) return [];
  const factor = Math.min(1, targetMinutes / total);
  return reasons.map((item) => ({ ...item, minutes: round2(Number(item.minutes || 0) * factor) }));
}

function overlapTotal(intervals, start, end) {
  return round2(intervals.reduce((sum, item) => sum + minutes(Math.max(start, item.start), Math.min(end, item.end)), 0));
}

function intervalMinutes(intervals) {
  return round2(intervals.reduce((sum, item) => sum + minutes(item.start, item.end), 0));
}

function minutes(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? round2((end - start) / 60_000) : 0;
}

function firstArrivalMs(events) {
  const values = events.filter((event) => event.event_type === 'arrival' && !event.cancelled_at).map((event) => parseDateTimeMs(event.occurred_at)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : Number.NaN;
}

function firstEventAt(events, type) {
  return events.filter((event) => event.event_type === type && !event.cancelled_at).map((event) => String(event.occurred_at || '')).filter(Boolean).sort()[0] || null;
}

function lastEventAt(events, type) {
  return events.filter((event) => event.event_type === type && !event.cancelled_at).map((event) => String(event.occurred_at || '')).filter(Boolean).sort().at(-1) || null;
}

function compareEvents(a, b) {
  return String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')) || Number(a.id || 0) - Number(b.id || 0);
}

function personPayload(person, fallbackId, type) {
  return { id: Number(person.person_id || person.student_id || person.id || fallbackId), type, name: person.person_name || person.student_name || person.name || '', classId: numericOrNull(person.class_id || person.classId), className: person.class_name || person.className || '', departmentId: numericOrNull(person.department_id), departmentName: person.department_name || '' };
}

function publicPeriod(range) {
  return { from: range.start_date || range.from, to: range.end_date || range.to, days: range.days_count || range.days?.length || 0, timezone: range.timezone || 'Europe/Moscow' };
}

function groupBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyOf(row);
    if (!key || key.startsWith('|')) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function validDate(value) {
  const text = String(value || '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const candidate = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return candidate.toISOString().slice(0, 10) === text ? text : '';
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function optionalPositiveInteger(value) {
  if (value == null || value === '') return null;
  return positiveInteger(value);
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
