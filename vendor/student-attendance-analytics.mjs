import { expectedPresenceDates } from './analytics.mjs';
import { isWithoutReasonCode } from './absence-reasons.mjs';
import {
  DEFAULT_ACTIVE_WEEKDAYS,
  buildScheduleIndex,
  dateOnly,
  formatDateLabel,
  lessonsForStudentDay,
  overlapMinutesForPeriod,
  parseDateTimeMs,
} from './schedule-analytics.mjs';

const ARRIVAL = 'arrival';
const DEPARTURE = 'departure';

export function buildStudentAttendanceAnalytics({
  range,
  students = [],
  periods = [],
  arrivals = [],
  presenceEvents = [],
  scheduleRows = [],
  publishedSchoolDays = [],
  activeWeekdays = DEFAULT_ACTIVE_WEEKDAYS,
} = {}) {
  if (!range) {
    return emptyStudentAttendance();
  }

  const schoolDays = expectedPresenceDates(range, { publishedSchoolDays, activeWeekdays });
  const schoolDaySet = new Set(schoolDays);
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const studentsById = buildStudentMap(students, periods, arrivals, presenceEvents);
  const arrivalsByDay = firstArrivalMap([...arrivals, ...presenceEvents], range, schoolDaySet);
  const eventsByDay = presenceEventsMap(presenceEvents, range, schoolDaySet);
  const absencesByDay = absenceSummaryMap(periods, range, schoolDaySet);
  const rows = Array.from(studentsById.values()).map((student) => buildStudentRow({
    student,
    schoolDays,
    scheduleIndex,
    arrivalsByDay,
    eventsByDay,
    absencesByDay,
    month: range.month,
  })).sort(compareStudentRows);

  return {
    school_days_total: schoolDays.length,
    school_days: schoolDays,
    students: rows,
    totals: rows.reduce((acc, row) => {
      acc.present_days += Number(row.present_days || 0);
      acc.absence_days += Number(row.absence_days || 0);
      acc.excused_absence_days += Number(row.excused_absence_days || 0);
      acc.unexcused_absence_days += Number(row.unexcused_absence_days || 0);
      acc.incomplete_days += Number(row.incomplete_days || 0);
      return acc;
    }, {
      present_days: 0,
      absence_days: 0,
      excused_absence_days: 0,
      unexcused_absence_days: 0,
      incomplete_days: 0,
    }),
  };
}

function emptyStudentAttendance() {
  return {
    school_days_total: 0,
    school_days: [],
    students: [],
    totals: {
      present_days: 0,
      absence_days: 0,
      excused_absence_days: 0,
      unexcused_absence_days: 0,
      incomplete_days: 0,
    },
  };
}

function buildStudentMap(students, periods, arrivals, presenceEvents) {
  const map = new Map();
  for (const item of [...students, ...periods, ...arrivals, ...presenceEvents]) {
    const id = String(item?.student_id || item?.id || item?.studentId || '').trim();
    if (!id || map.has(id)) continue;
    map.set(id, {
      student_id: id,
      student_name: item.student_name || item.name || '',
      class_id: String(item.class_id || item.classId || ''),
      class_name: item.class_name || item.className || '',
    });
  }
  return map;
}

function buildStudentRow({
  student,
  schoolDays,
  scheduleIndex,
  arrivalsByDay,
  eventsByDay,
  absencesByDay,
  month,
}) {
  let presentDays = 0;
  let absenceDays = 0;
  let excusedAbsenceDays = 0;
  let unexcusedAbsenceDays = 0;
  let incompleteDays = 0;
  const days = [];
  const absenceDetails = [];

  for (const day of schoolDays) {
    const key = studentDayKey(student.student_id, day);
    const arrival = arrivalsByDay.get(key) || null;
    const events = eventsByDay.get(key) || [];
    const absence = absencesByDay.get(key) || null;
    const lessons = lessonsForStudentDay(scheduleIndex, student, student, day);
    const incomplete = Boolean(arrival) && isIncompleteDay({ arrival, events, absence, lessons });
    const status = dayStatus({ arrival, absence, incomplete });

    if (arrival) presentDays += 1;
    if (absence) {
      absenceDays += 1;
      if (absence.has_unexcused) unexcusedAbsenceDays += 1;
      else excusedAbsenceDays += 1;
      absenceDetails.push(absenceDetail(day, absence));
    }
    if (incomplete) incompleteDays += 1;

    days.push({
      date: day,
      date_label: formatDateLabel(day),
      short_date_label: shortDateLabel(day),
      status_code: status.code,
      status_label: status.label,
      status_class: status.className,
      arrival_time: arrival?.arrival_at?.slice(11, 16) || '',
      departure_time: lastDepartureTime(events),
      reason_label: absence?.reason_label || '',
      absence_state_label: absenceStateLabel(absence),
      comment_label: absence?.comment_label || '',
      has_arrival: Boolean(arrival),
      has_absence: Boolean(absence),
      is_excused_absence: Boolean(absence && !absence.has_unexcused),
      is_unexcused_absence: Boolean(absence?.has_unexcused),
      is_incomplete: incomplete,
    });
  }

  return {
    student_id: student.student_id,
    student_name: student.student_name,
    class_id: student.class_id,
    class_name: student.class_name,
    school_days_total: schoolDays.length,
    present_days: presentDays,
    absence_days: absenceDays,
    excused_absence_days: excusedAbsenceDays,
    unexcused_absence_days: unexcusedAbsenceDays,
    incomplete_days: incompleteDays,
    absence_button_label: `Отсутствовал: ${absenceDays} ${dayWord(absenceDays)}`,
    metric_label: attendanceMetricLabel({
      presentDays,
      schoolDaysTotal: schoolDays.length,
      excusedAbsenceDays,
      unexcusedAbsenceDays,
      incompleteDays,
    }),
    href: `/attendance?class=${encodeURIComponent(student.class_id)}&student=${encodeURIComponent(student.student_id)}&analyticsMonth=${encodeURIComponent(month || '')}#learning-analytics`,
    days,
    absence_details: absenceDetails,
  };
}

function firstArrivalMap(rows, range, schoolDaySet) {
  const map = new Map();
  for (const row of rows || []) {
    const eventType = String(row.event_type || ARRIVAL);
    if (eventType !== ARRIVAL) continue;
    if (row.cancelled_at) continue;
    const studentId = String(row.student_id || row.studentId || '').trim();
    if (!studentId) continue;
    const attendanceDate = dateOnly(row.attendance_date || row.arrival_at || row.occurred_at);
    if (!isSchoolDayInRange(attendanceDate, range, schoolDaySet)) continue;
    const arrivalAt = normalizeDateTime(row.arrival_at || row.occurred_at);
    if (!arrivalAt) continue;

    const key = studentDayKey(studentId, attendanceDate);
    const next = {
      ...row,
      student_id: studentId,
      attendance_date: attendanceDate,
      arrival_at: arrivalAt,
    };
    const current = map.get(key);
    if (!current || compareEvents(next, current) < 0) {
      map.set(key, next);
    }
  }
  return map;
}

function presenceEventsMap(rows, range, schoolDaySet) {
  const map = new Map();
  for (const row of rows || []) {
    if (row.cancelled_at) continue;
    const studentId = String(row.student_id || row.studentId || '').trim();
    if (!studentId) continue;
    const attendanceDate = dateOnly(row.attendance_date || row.occurred_at);
    if (!isSchoolDayInRange(attendanceDate, range, schoolDaySet)) continue;
    const occurredAt = normalizeDateTime(row.occurred_at || row.arrival_at);
    if (!occurredAt) continue;
    const key = studentDayKey(studentId, attendanceDate);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      ...row,
      student_id: studentId,
      attendance_date: attendanceDate,
      occurred_at: occurredAt,
      event_type: normalizeEventType(row.event_type),
    });
  }
  for (const [key, events] of map.entries()) {
    map.set(key, events.sort(compareEvents));
  }
  return map;
}

function absenceSummaryMap(periods, range, schoolDaySet) {
  const map = new Map();
  for (const period of periods || []) {
    const studentId = String(period.student_id || '').trim();
    if (!studentId) continue;
    for (const day of expandPeriodDays(period, range)) {
      if (!schoolDaySet.has(day)) continue;
      const key = studentDayKey(studentId, day);
      if (!map.has(key)) map.set(key, createAbsenceSummary(studentId, day));
      addPeriodToAbsenceSummary(map.get(key), period);
    }
  }

  for (const summary of map.values()) {
    summary.reason_label = distinct(summary.reasons).join(', ');
    summary.comment_label = distinct(summary.comments).join('; ');
  }
  return map;
}

function createAbsenceSummary(studentId, day) {
  return {
    student_id: studentId,
    date: day,
    periods: [],
    reasons: [],
    comments: [],
    has_excused: false,
    has_unexcused: false,
    reason_label: '',
    comment_label: '',
  };
}

function addPeriodToAbsenceSummary(summary, period) {
  const unexcused = isUnexcusedPeriod(period);
  summary.periods.push(period);
  summary.reasons.push(period.reason_name || period.reason_code || '');
  if (period.comment) summary.comments.push(period.comment);
  summary.has_unexcused = summary.has_unexcused || unexcused;
  summary.has_excused = summary.has_excused || !unexcused;
}

function absenceDetail(day, absence) {
  return {
    date: day,
    date_label: formatDateLabel(day),
    short_date_label: shortDateLabel(day),
    status_label: 'отсутствовал',
    reason_label: absence.reason_label,
    absence_state_label: absenceStateLabel(absence),
    comment_label: absence.comment_label,
    is_excused: Boolean(absence && !absence.has_unexcused),
    is_unexcused: Boolean(absence?.has_unexcused),
  };
}

function dayStatus({ arrival, absence, incomplete }) {
  if (incomplete) {
    return {
      code: 'incomplete',
      label: 'неполный день',
      className: 'bg-sky-50 text-sky-700',
    };
  }
  if (arrival) {
    return {
      code: 'present',
      label: 'был в школе',
      className: 'bg-emerald-50 text-emerald-700',
    };
  }
  if (absence?.has_unexcused) {
    return {
      code: 'unexcused_absence',
      label: 'отсутствовал без причины',
      className: 'bg-amber-50 text-amber-800',
    };
  }
  if (absence) {
    return {
      code: 'excused_absence',
      label: 'отсутствовал по уважительной причине',
      className: 'bg-indigo-50 text-indigo-700',
    };
  }
  return {
    code: 'no_mark',
    label: 'нет отметки',
    className: 'bg-gray-100 text-gray-600',
  };
}

function isIncompleteDay({ arrival, events, absence, lessons }) {
  if (!arrival || !lessons.length) return Boolean(absence);

  const arrivalMs = parseDateTimeMs(arrival.arrival_at);
  if (Number.isFinite(arrivalMs) && arrivalMs > lessons[0].starts_ms) {
    return true;
  }

  const lastDeparture = lastDepartureEvent(events);
  const lastLesson = lessons.at(-1);
  const departureMs = parseDateTimeMs(lastDeparture?.occurred_at);
  if (Number.isFinite(departureMs) && lastLesson && departureMs < lastLesson.ends_ms) {
    return true;
  }

  return (absence?.periods || []).some((period) => (
    lessons.some((lesson) => overlapMinutesForPeriod(period, lesson, {
      start_at: `${lesson.date} 00:00:00`,
      end_at: `${lesson.date} 23:59:59`,
    }) > 0)
  ));
}

function lastDepartureEvent(events) {
  return [...(events || [])].reverse().find((event) => event.event_type === DEPARTURE) || null;
}

function lastDepartureTime(events) {
  return lastDepartureEvent(events)?.occurred_at?.slice(11, 16) || '';
}

function absenceStateLabel(absence) {
  if (!absence) return '';
  return absence.has_unexcused ? 'без причины' : 'уважительная причина';
}

function isUnexcusedPeriod(period) {
  return isWithoutReasonCode(period.reason_code) || Number(period.is_excused) === 0;
}

function attendanceMetricLabel({
  presentDays,
  schoolDaysTotal,
  excusedAbsenceDays,
  unexcusedAbsenceDays,
  incompleteDays,
}) {
  return [
    `${presentDays}/${schoolDaysTotal} присутствовал`,
    `${excusedAbsenceDays} уважительно`,
    `${unexcusedAbsenceDays} без причины`,
    `${incompleteDays} ${incompleteDayWord(incompleteDays)}`,
  ].join(' · ');
}

function expandPeriodDays(period, range) {
  const startDate = dateOnly(period.starts_at);
  const endDate = dateOnly(period.ends_at || period.starts_at);
  if (!startDate || !endDate) return [];
  const from = maxDate(startDate, range.start_date);
  const to = minDate(endDate, range.end_date);
  if (from > to) return [];
  const days = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

function isSchoolDayInRange(day, range, schoolDaySet) {
  return Boolean(day && day >= range.start_date && day <= range.end_date && schoolDaySet.has(day));
}

function compareEvents(left, right) {
  return (
    String(left.occurred_at || left.arrival_at || '').localeCompare(String(right.occurred_at || right.arrival_at || '')) ||
    String(left.id || '').localeCompare(String(right.id || ''), undefined, { numeric: true })
  );
}

function compareStudentRows(left, right) {
  return (
    String(left.class_name || '').localeCompare(String(right.class_name || ''), 'ru', { numeric: true, sensitivity: 'base' }) ||
    String(left.student_name || '').localeCompare(String(right.student_name || ''), 'ru', { numeric: true, sensitivity: 'base' })
  );
}

function normalizeEventType(value) {
  return String(value || ARRIVAL) === DEPARTURE ? DEPARTURE : ARRIVAL;
}

function normalizeDateTime(value) {
  const raw = String(value || '');
  return Number.isFinite(parseDateTimeMs(raw)) ? raw.slice(0, 19).replace('T', ' ') : '';
}

function shortDateLabel(day) {
  return formatDateLabel(day).slice(0, 5);
}

function studentDayKey(studentId, day) {
  return `${studentId}|${day}`;
}

function distinct(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function dayWord(value) {
  const count = Math.abs(Number(value || 0));
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'дней';
  if (mod10 === 1) return 'день';
  if (mod10 >= 2 && mod10 <= 4) return 'дня';
  return 'дней';
}

function incompleteDayWord(value) {
  const count = Math.abs(Number(value || 0));
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'неполных дней';
  if (mod10 === 1) return 'неполный день';
  if (mod10 >= 2 && mod10 <= 4) return 'неполных дня';
  return 'неполных дней';
}

function addDays(dateText, amount) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function minDate(a, b) {
  return a < b ? a : b;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
