import { conflictInterval } from './attendance-reconciliation.mjs';
import {
  buildScheduleIndex,
  dateOnly,
  formatDateLabel,
  isoWeekday,
  lessonsForStudentDay,
  parseDateTimeMs,
} from './schedule-analytics.mjs';

export function buildScheduledAttendanceAnalytics({
  range,
  students = [],
  periods = [],
  presenceEvents = [],
  conflicts = [],
  scheduleRows = [],
  publishedSchoolDays = [],
  activeWeekdays = [1, 2, 3, 4, 5],
  now = '',
} = {}) {
  if (!range) return emptyScheduledAnalytics();

  const nowMs = parseDateTimeMs(now || range.end_at);
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const published = new Set(publishedSchoolDays.map(dateOnly).filter(Boolean));
  const expectedWeekdays = new Set((activeWeekdays || []).map(Number).filter((value) => value >= 1 && value <= 7));
  const periodsByStudent = groupByStudent(periods);
  const eventsByStudentDay = groupEventsByStudentDay(presenceEvents);
  const conflictsByStudentDay = groupConflictsByStudentDay(conflicts);
  const studentRows = [];
  const dailyBuckets = new Map();

  for (const student of students) {
    const studentId = String(student.student_id || student.id || '');
    if (!studentId) continue;
    const row = createStudentRow(student);

    for (const day of range.days || []) {
      const dayStartMs = parseDateTimeMs(`${day} 00:00:00`);
      if (!Number.isFinite(dayStartMs) || dayStartMs > nowMs) continue;
      const isPublished = published.has(day);
      const lessons = isPublished ? lessonsForStudentDay(scheduleIndex, student, student, day) : [];
      const scheduled = mergeIntervals(lessons.map((lesson) => ({ start: lesson.starts_ms, end: lesson.ends_ms })));
      if (!isPublished || !scheduled.length) {
        if ((isPublished || expectedWeekdays.has(isoWeekday(day))) && dayStartMs <= nowMs) {
          row.schedule_gap_days += 1;
          row.days.push(dayPayload(day, 'schedule_gap'));
        }
        continue;
      }

      const actualScheduled = clipIntervals(scheduled, Number.NEGATIVE_INFINITY, nowMs);
      if (!actualScheduled.length) continue;
      const key = studentDayKey(studentId, day);
      const presence = presenceIntervals(eventsByStudentDay.get(key) || [], actualScheduled, nowMs);
      const absences = periodIntervals(periodsByStudent.get(studentId) || [], day, nowMs);
      const conflictIntervals = (conflictsByStudentDay.get(key) || [])
        .map(conflictInterval)
        .filter(Boolean)
        .map((item) => ({ start: parseDateTimeMs(item.starts_at), end: parseDateTimeMs(item.ends_at) }));
      const eligible = subtractIntervals(actualScheduled, conflictIntervals);
      const confirmedAbsence = intersectIntervals(eligible, absences);
      const attendedBeforeAbsence = intersectIntervals(eligible, presence);
      const attended = subtractIntervals(attendedBeforeAbsence, absences);
      const eligibleMinutes = intervalMinutes(eligible);
      const attendedMinutes = intervalMinutes(attended);
      const confirmedAbsenceMinutes = intervalMinutes(confirmedAbsence);
      const missedMinutes = Math.max(0, eligibleMinutes - attendedMinutes);
      const noMarkMinutes = Math.max(0, missedMinutes - confirmedAbsenceMinutes);
      const conflictMinutes = Math.max(0, intervalMinutes(actualScheduled) - eligibleMinutes);
      const status = conflictMinutes > 0
        ? 'conflict'
        : attendedMinutes >= eligibleMinutes && eligibleMinutes > 0
          ? 'present'
          : attendedMinutes > 0
            ? 'incomplete'
            : 'absent';

      row.scheduled_minutes += eligibleMinutes;
      row.attended_minutes += attendedMinutes;
      row.missed_minutes += missedMinutes;
      row.confirmed_absence_minutes += confirmedAbsenceMinutes;
      row.no_mark_minutes += noMarkMinutes;
      row.conflict_minutes += conflictMinutes;
      row.school_days_total += 1;
      if (attendedMinutes > 0) row.present_days += 1;
      if (status === 'absent') row.absence_days += 1;
      if (status === 'incomplete') row.incomplete_days += 1;
      if (status === 'conflict') row.conflict_days += 1;
      row.days.push(dayPayload(day, status, {
        scheduled_minutes: eligibleMinutes,
        attended_minutes: attendedMinutes,
        missed_minutes: missedMinutes,
        confirmed_absence_minutes: confirmedAbsenceMinutes,
        no_mark_minutes: noMarkMinutes,
        conflict_minutes: conflictMinutes,
      }));

      const daily = ensureDailyBucket(dailyBuckets, day);
      daily.scheduled_minutes += eligibleMinutes;
      daily.attended_minutes += attendedMinutes;
      daily.missed_minutes += missedMinutes;
      daily.confirmed_absence_minutes += confirmedAbsenceMinutes;
      daily.no_mark_minutes += noMarkMinutes;
      daily.conflict_minutes += conflictMinutes;
      if (status === 'absent') daily.absent_students += 1;
      if (status === 'incomplete') daily.incomplete_students += 1;
      if (status === 'conflict') daily.conflict_students += 1;
    }

    row.attendance_percent = percent(row.attended_minutes, row.scheduled_minutes);
    row.metric_label = `${row.attendance_percent}% · ${formatHours(row.attended_minutes)} из ${formatHours(row.scheduled_minutes)}`;
    row.absence_button_label = `Не присутствовал: ${row.absence_days}`;
    studentRows.push(row);
  }

  const totals = studentRows.reduce((acc, row) => {
    for (const key of Object.keys(acc)) acc[key] += Number(row[key] || 0);
    return acc;
  }, totalsShape());
  totals.attendance_percent = percent(totals.attended_minutes, totals.scheduled_minutes);

  const planned = plannedAbsenceMetrics({ range, students, periods, scheduleIndex, published, nowMs });
  return {
    metric_version: 2,
    basis: 'scheduled_minutes',
    actual: totals,
    planned,
    quality: {
      schedule_gap_student_days: studentRows.reduce((sum, row) => sum + row.schedule_gap_days, 0),
      conflict_student_days: studentRows.reduce((sum, row) => sum + row.conflict_days, 0),
      conflict_minutes: totals.conflict_minutes,
    },
    school_days_total: Math.max(0, ...studentRows.map((row) => row.school_days_total)),
    students: studentRows,
    daily: Array.from(dailyBuckets.values()).sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({
      ...row,
      date_label: formatDateLabel(row.date),
      attendance_percent: percent(row.attended_minutes, row.scheduled_minutes),
    })),
  };
}

export function buildObservedAdultAnalytics({ range, people = [], periods = [], presenceEvents = [], conflicts = [], now = '' } = {}) {
  if (!range) return { metric_version: 2, basis: 'observed_intervals', actual: {}, planned: {}, quality: {} };
  const nowMs = parseDateTimeMs(now || range.end_at);
  const eventsByStudentDay = groupEventsByStudentDay(presenceEvents);
  const conflictIds = new Set(conflicts.filter((item) => item.status === 'open').map((item) => String(item.presence_event_id || '')));
  const rows = [];

  for (const person of people) {
    const personId = String(person.student_id || person.id || '');
    let onsiteMinutes = 0;
    let presentDays = 0;
    let unmatchedEvents = 0;
    for (const day of range.days || []) {
      const events = (eventsByStudentDay.get(studentDayKey(personId, day)) || []).filter((event) => !conflictIds.has(String(event.id || '')));
      if (events.some((event) => event.event_type === 'arrival')) presentDays += 1;
      const paired = pairObservedIntervals(events, nowMs, day === dateOnly(now || range.end_at));
      onsiteMinutes += intervalMinutes(paired.intervals);
      unmatchedEvents += paired.unmatched;
    }
    rows.push({ person_id: personId, onsite_minutes: onsiteMinutes, present_days: presentDays, unmatched_events: unmatchedEvents });
  }
  const actual = rows.reduce((acc, row) => {
    acc.onsite_minutes += row.onsite_minutes;
    acc.present_days += row.present_days;
    acc.unmatched_events += row.unmatched_events;
    return acc;
  }, { onsite_minutes: 0, present_days: 0, unmatched_events: 0, attendance_percent: null, expected_minutes: null });

  const plannedPeriods = periods.filter((period) => parseDateTimeMs(period.starts_at) > nowMs).length;
  return {
    metric_version: 2,
    basis: 'observed_intervals',
    actual,
    planned: { periods: plannedPeriods },
    quality: { open_conflicts: conflicts.filter((item) => item.status === 'open').length, unmatched_events: actual.unmatched_events },
    people: rows,
  };
}

function plannedAbsenceMetrics({ range, students, periods, scheduleIndex, published, nowMs }) {
  let absenceMinutes = 0;
  const studentDays = new Set();
  for (const student of students) {
    const studentId = String(student.student_id || student.id || '');
    const studentPeriods = periods.filter((period) => String(period.student_id || '') === studentId);
    for (const day of range.days || []) {
      if (!published.has(day)) continue;
      const lessons = mergeIntervals(lessonsForStudentDay(scheduleIndex, student, student, day).map((lesson) => ({ start: lesson.starts_ms, end: lesson.ends_ms })));
      const futureLessons = clipIntervals(lessons, nowMs, Number.POSITIVE_INFINITY);
      const plannedAbsences = periodIntervals(studentPeriods, day, Number.POSITIVE_INFINITY).filter((item) => item.end > nowMs);
      const minutes = intervalMinutes(intersectIntervals(futureLessons, plannedAbsences));
      if (minutes <= 0) continue;
      absenceMinutes += minutes;
      studentDays.add(studentDayKey(studentId, day));
    }
  }
  return { absence_minutes: absenceMinutes, absence_hours: round1(absenceMinutes / 60), absence_days: studentDays.size };
}

function pairObservedIntervals(events, nowMs, isToday) {
  const sorted = [...events].filter((event) => !event.cancelled_at).sort(compareEvents);
  const intervals = [];
  let arrival = null;
  let unmatched = 0;
  for (const event of sorted) {
    const occurred = parseDateTimeMs(event.occurred_at);
    if (!Number.isFinite(occurred)) continue;
    if (event.event_type === 'arrival') {
      if (arrival != null) unmatched += 1;
      else arrival = occurred;
    } else if (arrival != null && occurred > arrival) {
      intervals.push({ start: arrival, end: occurred });
      arrival = null;
    } else {
      unmatched += 1;
    }
  }
  if (arrival != null) {
    if (isToday && nowMs > arrival) intervals.push({ start: arrival, end: nowMs });
    else unmatched += 1;
  }
  return { intervals, unmatched };
}

function presenceIntervals(events, scheduled, nowMs) {
  const dayEnd = Math.min(nowMs, Math.max(...scheduled.map((item) => item.end)));
  const sorted = [...events].filter((event) => !event.cancelled_at && parseDateTimeMs(event.occurred_at) <= nowMs).sort(compareEvents);
  const intervals = [];
  let start = null;
  for (const event of sorted) {
    const occurred = parseDateTimeMs(event.occurred_at);
    if (!Number.isFinite(occurred)) continue;
    if (event.event_type === 'arrival') {
      if (start == null) start = occurred;
    } else if (start != null && occurred > start) {
      intervals.push({ start, end: occurred });
      start = null;
    }
  }
  if (start != null && dayEnd > start) intervals.push({ start, end: dayEnd });
  return mergeIntervals(intervals);
}

function periodIntervals(periods, day, upperBound) {
  const dayStart = parseDateTimeMs(`${day} 00:00:00`);
  const dayEnd = parseDateTimeMs(`${day} 23:59:59`);
  return mergeIntervals(periods.map((period) => ({
    start: Math.max(parseDateTimeMs(period.starts_at), dayStart),
    end: Math.min(parseDateTimeMs(period.ends_at), dayEnd, upperBound),
  })).filter(validInterval));
}

function groupByStudent(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = String(row.student_id || '');
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

function groupEventsByStudentDay(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const id = String(row.student_id || '');
    const day = dateOnly(row.attendance_date || row.occurred_at);
    if (!id || !day) continue;
    const key = studentDayKey(id, day);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function groupConflictsByStudentDay(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (row.status !== 'open') continue;
    const id = String(row.student_id || '');
    const day = dateOnly(row.occurred_at || row.conflict_starts_at);
    if (!id || !day) continue;
    const key = studentDayKey(id, day);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function intersectIntervals(left, right) {
  const result = [];
  for (const a of left || []) {
    for (const b of right || []) {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (end > start) result.push({ start, end });
    }
  }
  return mergeIntervals(result);
}

function subtractIntervals(source, cuts) {
  let result = mergeIntervals(source);
  for (const cut of mergeIntervals(cuts)) {
    const next = [];
    for (const item of result) {
      if (cut.end <= item.start || cut.start >= item.end) next.push(item);
      else {
        if (cut.start > item.start) next.push({ start: item.start, end: cut.start });
        if (cut.end < item.end) next.push({ start: cut.end, end: item.end });
      }
    }
    result = next;
  }
  return result;
}

function clipIntervals(intervals, from, to) {
  return mergeIntervals((intervals || []).map((item) => ({ start: Math.max(item.start, from), end: Math.min(item.end, to) })).filter(validInterval));
}

function mergeIntervals(intervals) {
  const sorted = (intervals || []).filter(validInterval).sort((a, b) => a.start - b.start || a.end - b.end);
  const result = [];
  for (const item of sorted) {
    const last = result.at(-1);
    if (!last || item.start > last.end) result.push({ ...item });
    else last.end = Math.max(last.end, item.end);
  }
  return result;
}

function validInterval(item) {
  return Number.isFinite(item?.start) && Number.isFinite(item?.end) && item.end > item.start;
}

function intervalMinutes(intervals) {
  return round1((intervals || []).reduce((sum, item) => sum + Math.max(0, item.end - item.start), 0) / 60_000);
}

function compareEvents(left, right) {
  return String(left.occurred_at || '').localeCompare(String(right.occurred_at || '')) || Number(left.id || 0) - Number(right.id || 0);
}

function createStudentRow(student) {
  return {
    student_id: String(student.student_id || student.id || ''),
    student_name: student.student_name || student.name || '',
    class_id: String(student.class_id || student.classId || ''),
    class_name: student.class_name || student.className || '',
    scheduled_minutes: 0,
    attended_minutes: 0,
    missed_minutes: 0,
    confirmed_absence_minutes: 0,
    no_mark_minutes: 0,
    conflict_minutes: 0,
    school_days_total: 0,
    present_days: 0,
    absence_days: 0,
    incomplete_days: 0,
    conflict_days: 0,
    schedule_gap_days: 0,
    days: [],
  };
}

function dayPayload(day, statusCode, metrics = {}) {
  const labels = {
    present: 'присутствовал',
    incomplete: 'неполный день',
    absent: 'отсутствовал',
    conflict: 'конфликт отметок',
    schedule_gap: 'нет расписания',
  };
  return {
    date: day,
    date_label: formatDateLabel(day),
    short_date_label: formatDateLabel(day).slice(0, 5),
    status_code: statusCode,
    status_label: labels[statusCode] || statusCode,
    status_class: statusCode === 'present'
      ? 'bg-emerald-50 text-emerald-700'
      : statusCode === 'conflict'
        ? 'bg-red-50 text-red-700'
        : statusCode === 'incomplete'
          ? 'bg-sky-50 text-sky-700'
          : 'bg-gray-100 text-gray-600',
    ...metrics,
  };
}

function ensureDailyBucket(map, date) {
  if (!map.has(date)) map.set(date, {
    date,
    scheduled_minutes: 0,
    attended_minutes: 0,
    missed_minutes: 0,
    confirmed_absence_minutes: 0,
    no_mark_minutes: 0,
    conflict_minutes: 0,
    absent_students: 0,
    incomplete_students: 0,
    conflict_students: 0,
  });
  return map.get(date);
}

function totalsShape() {
  return {
    scheduled_minutes: 0,
    attended_minutes: 0,
    missed_minutes: 0,
    confirmed_absence_minutes: 0,
    no_mark_minutes: 0,
    conflict_minutes: 0,
    school_days_total: 0,
    present_days: 0,
    absence_days: 0,
    incomplete_days: 0,
    conflict_days: 0,
    schedule_gap_days: 0,
  };
}

function emptyScheduledAnalytics() {
  return { metric_version: 2, basis: 'scheduled_minutes', actual: { ...totalsShape(), attendance_percent: 0 }, planned: {}, quality: {}, students: [], daily: [] };
}

function studentDayKey(studentId, day) {
  return `${studentId}|${day}`;
}

function percent(value, total) {
  return total > 0 ? Math.round((Number(value || 0) / Number(total)) * 100) : 0;
}

function formatHours(minutes) {
  return `${round1(Number(minutes || 0) / 60).toLocaleString('ru-RU')} ч.`;
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}
