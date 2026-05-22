import { percentOf } from './analytics.mjs';
import {
  DEFAULT_ACTIVE_WEEKDAYS,
  buildScheduleIndex,
  dateOnly,
  formatDateLabel,
  formatMinutes,
  formatSqlDateTime,
  isoWeekday,
  lessonsForStudentDay,
  overlapMinutesForInterval,
  parseDateTimeMs,
} from './schedule-analytics.mjs';

export const LATE_THRESHOLD_MINUTES = 5;
export const LATE_MISSED_LESSON_MIN_OVERLAP_MINUTES = 15;

const EMPTY_LATENESS = {
  late_days_total: 0,
  students_late_total: 0,
  students_with_arrivals_total: 0,
  missed_lessons_total: 0,
  subjects_total: 0,
  total_late_minutes: 0,
  avg_late_minutes: 0,
  max_late_minutes: 0,
  coverage: {
    arrival_days_total: 0,
    covered_arrival_days: 0,
    data_gaps_total: 0,
    coverage_percent: 100,
  },
  students: [],
  classes: [],
  subjects: [],
  daily: [],
  daily_active: [],
  data_gaps: [],
  data_gaps_total: 0,
  has_data: false,
  has_activity: false,
};

export function buildLateAnalytics({
  range,
  students = [],
  arrivals = [],
  scheduleRows = [],
  publishedSchoolDays = [],
  activeWeekdays = DEFAULT_ACTIVE_WEEKDAYS,
  includeEvents = false,
} = {}) {
  if (!range) {
    return includeEvents ? { ...EMPTY_LATENESS, events: [] } : { ...EMPTY_LATENESS };
  }

  const studentById = buildStudentMap(students, arrivals);
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const publishedDaySet = new Set(publishedSchoolDays.map(dateOnly).filter(Boolean));
  const activeWeekdaySet = new Set((activeWeekdays || DEFAULT_ACTIVE_WEEKDAYS).map(Number));
  const firstArrivals = firstArrivalRows(arrivals, range).filter((arrival) => activeWeekdaySet.has(isoWeekday(arrival.attendance_date)));
  const lateEvents = [];
  const dataGaps = [];

  for (const arrival of firstArrivals) {
    const student = studentById.get(String(arrival.student_id)) || arrival;
    const day = arrival.attendance_date;
    if (!publishedDaySet.has(day)) {
      dataGaps.push(createDataGap(arrival, student, 'no_published_schedule', 'Нет опубликованного расписания'));
      continue;
    }

    const lessons = lessonsForStudentDay(scheduleIndex, arrival, student, day);
    if (!lessons.length) {
      dataGaps.push(createDataGap(arrival, student, 'no_lessons_for_student_day', 'Нет уроков в расписании ученика'));
      continue;
    }

    const firstLesson = lessons[0];
    const arrivalMs = parseDateTimeMs(arrival.arrival_at);
    const lateMinutesRaw = (arrivalMs - firstLesson.starts_ms) / 60_000;
    if (!(lateMinutesRaw > LATE_THRESHOLD_MINUTES)) continue;

    const missedLessons = lessons.filter((lesson) => (
      overlapMinutesForInterval(firstLesson.starts_at, arrival.arrival_at, lesson, range) > LATE_MISSED_LESSON_MIN_OVERLAP_MINUTES
    ));
    lateEvents.push(createLateEvent(arrival, student, firstLesson, missedLessons, lateMinutesRaw));
  }

  lateEvents.sort(compareLateEvents);
  const lateness = aggregateLateness({ range, students, firstArrivals, lateEvents, dataGaps });
  if (includeEvents) {
    lateness.events = lateEvents;
  }
  return lateness;
}

function firstArrivalRows(rows, range) {
  const byStudentDay = new Map();
  for (const row of rows || []) {
    if (row.event_type && row.event_type !== 'arrival') continue;
    if (row.cancelled_at) continue;
    const studentId = String(row.student_id || row.studentId || '');
    if (!studentId) continue;
    const attendanceDate = dateOnly(row.attendance_date || row.arrival_at || row.occurred_at);
    if (!attendanceDate || attendanceDate < range.start_date || attendanceDate > range.end_date) continue;
    const arrivalAt = normalizeDateTime(row.arrival_at || row.occurred_at);
    if (!arrivalAt) continue;

    const key = `${studentId}|${attendanceDate}`;
    const current = byStudentDay.get(key);
    if (current && compareArrivalRows(current, { ...row, arrival_at: arrivalAt }) <= 0) continue;
    byStudentDay.set(key, {
      ...row,
      student_id: studentId,
      class_id: String(row.class_id || row.classId || ''),
      student_name: row.student_name || row.name || '',
      class_name: row.class_name || row.className || '',
      attendance_date: attendanceDate,
      arrival_at: arrivalAt,
    });
  }
  return Array.from(byStudentDay.values()).sort(compareArrivalRows);
}

function buildStudentMap(students, arrivals) {
  const map = new Map();
  for (const student of students || []) {
    const id = String(student.student_id || student.id || '');
    if (!id) continue;
    map.set(id, {
      student_id: id,
      student_name: student.student_name || student.name || '',
      class_id: String(student.class_id || student.classId || ''),
      class_name: student.class_name || student.className || '',
    });
  }
  for (const arrival of arrivals || []) {
    const id = String(arrival.student_id || arrival.studentId || '');
    if (!id || map.has(id)) continue;
    map.set(id, {
      student_id: id,
      student_name: arrival.student_name || arrival.name || '',
      class_id: String(arrival.class_id || arrival.classId || ''),
      class_name: arrival.class_name || arrival.className || '',
    });
  }
  return map;
}

function createLateEvent(arrival, student, firstLesson, missedLessons, lateMinutesRaw) {
  const missedLessonRows = missedLessons.map((lesson) => {
    const overlapMinutes = overlapMinutesForInterval(firstLesson.starts_at, arrival.arrival_at, lesson);
    return {
      entry_ids: lesson.entry_ids,
      lesson_number: lesson.lesson_number,
      slot_id: lesson.slot_id,
      starts_at: lesson.starts_at,
      ends_at: lesson.ends_at,
      time_label: lesson.time_label,
      subject_id: lesson.subject_id,
      subject_name: lesson.subject_name,
      subject_type: lesson.subject_type,
      teacher_id: lesson.teacher_id,
      teacher_name: lesson.teacher_name,
      room_id: lesson.room_id,
      room_name: lesson.room_name,
      overlap_minutes: Math.round(overlapMinutes),
      overlap_label: formatMinutes(overlapMinutes),
      has_conflict: Boolean(lesson.has_conflict),
      conflict_subjects: lesson.conflict_subjects || '',
      source_scope: lesson.scope,
    };
  });
  const missedSubjectNames = distinct(missedLessonRows.map((lesson) => lesson.subject_name));
  const lateMinutes = Math.ceil(lateMinutesRaw);

  return {
    id: `${arrival.student_id}:${arrival.attendance_date}`,
    student_id: String(arrival.student_id),
    student_name: student.student_name || arrival.student_name || '',
    class_id: String(arrival.class_id || student.class_id || ''),
    class_name: student.class_name || arrival.class_name || firstLesson.class_name || '',
    date: arrival.attendance_date,
    date_label: formatDateLabel(arrival.attendance_date),
    arrival_at: arrival.arrival_at,
    arrival_time: arrival.arrival_at.slice(11, 16),
    first_lesson_starts_at: firstLesson.starts_at,
    first_lesson_time: firstLesson.starts_at.slice(11, 16),
    first_lesson_number: firstLesson.lesson_number,
    first_subject_name: firstLesson.subject_name,
    late_minutes: lateMinutes,
    late_label: formatMinutes(lateMinutes),
    missed_lessons: missedLessonRows.length,
    missed_subjects: missedSubjectNames.length,
    missed_subject_names: missedSubjectNames.join(', '),
    missed_lessons_list: missedLessonRows,
  };
}

function createDataGap(arrival, student, code, message) {
  return {
    code,
    message,
    student_id: String(arrival.student_id),
    student_name: student.student_name || arrival.student_name || '',
    class_id: String(arrival.class_id || student.class_id || ''),
    class_name: student.class_name || arrival.class_name || '',
    date: arrival.attendance_date,
    date_label: formatDateLabel(arrival.attendance_date),
    arrival_at: arrival.arrival_at,
    arrival_time: arrival.arrival_at.slice(11, 16),
  };
}

function aggregateLateness({ range, students, firstArrivals, lateEvents, dataGaps }) {
  const studentBuckets = new Map();
  const subjectBuckets = new Map();
  const dailyBuckets = new Map((range.days || []).map((day) => [day, createDailyBucket(day)]));
  const arrivalStudentIds = new Set();
  const lateStudentIds = new Set();
  let totalLateMinutes = 0;
  let maxLateMinutes = 0;

  for (const student of students || []) {
    const id = String(student.student_id || student.id || '');
    if (!id) continue;
    ensureStudentBucket(studentBuckets, {
      student_id: id,
      student_name: student.student_name || student.name || '',
      class_id: String(student.class_id || student.classId || ''),
      class_name: student.class_name || student.className || '',
    });
  }

  for (const arrival of firstArrivals) {
    arrivalStudentIds.add(String(arrival.student_id));
    const bucket = ensureStudentBucket(studentBuckets, arrival);
    bucket.arrivalDays.add(`${arrival.student_id}|${arrival.attendance_date}`);
  }

  for (const gap of dataGaps) {
    ensureStudentBucket(studentBuckets, gap).dataGaps.push(gap);
    const dailyBucket = dailyBuckets.get(gap.date) || createDailyBucket(gap.date);
    dailyBucket.dataGaps.push(gap);
    dailyBuckets.set(gap.date, dailyBucket);
  }

  for (const event of lateEvents) {
    totalLateMinutes += Number(event.late_minutes || 0);
    maxLateMinutes = Math.max(maxLateMinutes, Number(event.late_minutes || 0));
    lateStudentIds.add(String(event.student_id));

    const studentBucket = ensureStudentBucket(studentBuckets, event);
    studentBucket.events.push(event);
    for (const lesson of event.missed_lessons_list || []) {
      ensureSubjectBucket(subjectBuckets, lesson).lessons.push({ ...lesson, event });
      studentBucket.subjectKeys.add(lesson.subject_id || lesson.subject_name);
    }

    const dailyBucket = dailyBuckets.get(event.date) || createDailyBucket(event.date);
    dailyBucket.events.push(event);
    dailyBuckets.set(event.date, dailyBucket);
  }

  const maxStudentLateDays = Math.max(1, ...Array.from(studentBuckets.values()).map((item) => item.events.length));
  const studentRows = Array.from(studentBuckets.values()).map((bucket) => {
    const lateDays = bucket.events.length;
    const arrivalDays = bucket.arrivalDays.size;
    const totalMinutes = bucket.events.reduce((sum, event) => sum + Number(event.late_minutes || 0), 0);
    const missedLessons = bucket.events.reduce((sum, event) => sum + Number(event.missed_lessons || 0), 0);
    const lastLate = bucket.events.toSorted(compareLateEvents).at(-1);
    const dataGaps = bucket.dataGaps.length;
    const status = latenessStudentStatus({ lateDays, arrivalDays, dataGaps });
    return {
      student_id: bucket.student_id,
      student_name: bucket.student_name,
      class_id: bucket.class_id,
      class_name: bucket.class_name,
      arrival_days: arrivalDays,
      late_days: lateDays,
      late_percent: percentOf(lateDays, arrivalDays),
      total_late_minutes: totalMinutes,
      avg_late_minutes: lateDays ? Math.round(totalMinutes / lateDays) : 0,
      missed_lessons: missedLessons,
      subjects: bucket.subjectKeys.size,
      data_gaps: dataGaps,
      status_code: status.code,
      status_label: status.label,
      status_class: status.className,
      detail_label: latenessStudentDetailLabel({ lateDays, arrivalDays, totalMinutes, missedLessons, dataGaps, lastLate }),
      last_late_at: lastLate?.arrival_at || '',
      last_late_date: lastLate?.date_label || '',
      last_late_time: lastLate ? `${lastLate.arrival_time} / ${lastLate.first_lesson_time}` : '',
      last_late_label: lastLate ? `${lastLate.date_label} ${lastLate.arrival_time}, ${lastLate.late_minutes} мин.` : '',
      href: `/attendance?class=${encodeURIComponent(bucket.class_id)}&student=${encodeURIComponent(bucket.student_id)}&analyticsMonth=${encodeURIComponent(range.month)}#lateness-analytics`,
      bar_width: percentOf(lateDays, maxStudentLateDays),
    };
  }).filter((row) => row.arrival_days > 0 || row.late_days > 0 || row.data_gaps > 0)
    .sort(compareStudentRows);
  const classRows = buildLatenessClassRows(studentRows);

  const totalMissedLessons = lateEvents.reduce((sum, event) => sum + Number(event.missed_lessons || 0), 0);
  const subjectRows = Array.from(subjectBuckets.values()).map((bucket) => {
    const studentsSet = new Set(bucket.lessons.map((item) => item.event.student_id));
    const daysSet = new Set(bucket.lessons.map((item) => `${item.event.student_id}|${item.event.date}`));
    return {
      subject_id: bucket.subject_id,
      subject_name: bucket.subject_name,
      subject_type: bucket.subject_type,
      missed_lessons: bucket.lessons.length,
      students: studentsSet.size,
      late_days: daysSet.size,
      percent: percentOf(bucket.lessons.length, totalMissedLessons),
      bar_width: percentOf(bucket.lessons.length, totalMissedLessons),
    };
  }).sort(compareSubjectRows);

  const dailyRows = Array.from(dailyBuckets.values()).map((bucket) => {
    const studentsSet = new Set(bucket.events.map((event) => event.student_id));
    const minutes = bucket.events.reduce((sum, event) => sum + Number(event.late_minutes || 0), 0);
    return {
      date: bucket.date,
      date_label: formatDateLabel(bucket.date),
      late_students: studentsSet.size,
      late_days: bucket.events.length,
      missed_lessons: bucket.events.reduce((sum, event) => sum + Number(event.missed_lessons || 0), 0),
      avg_late_minutes: bucket.events.length ? Math.round(minutes / bucket.events.length) : 0,
      max_late_minutes: Math.max(0, ...bucket.events.map((event) => Number(event.late_minutes || 0))),
      data_gaps: bucket.dataGaps.length,
      bar_width: percentOf(bucket.events.length, Math.max(1, lateEvents.length)),
    };
  });
  const dailyActiveRows = dailyRows.filter((row) => row.late_days > 0 || row.data_gaps > 0);

  const coveredArrivalDays = Math.max(0, firstArrivals.length - dataGaps.length);
  return {
    late_days_total: lateEvents.length,
    students_late_total: lateStudentIds.size,
    students_with_arrivals_total: arrivalStudentIds.size,
    missed_lessons_total: totalMissedLessons,
    subjects_total: subjectRows.length,
    total_late_minutes: totalLateMinutes,
    avg_late_minutes: lateEvents.length ? Math.round(totalLateMinutes / lateEvents.length) : 0,
    max_late_minutes: maxLateMinutes,
    coverage: {
      arrival_days_total: firstArrivals.length,
      covered_arrival_days: coveredArrivalDays,
      data_gaps_total: dataGaps.length,
      coverage_percent: firstArrivals.length ? percentOf(coveredArrivalDays, firstArrivals.length) : 100,
    },
    students: studentRows,
    classes: classRows,
    subjects: subjectRows,
    daily: dailyRows,
    daily_active: dailyActiveRows,
    data_gaps: dataGaps,
    data_gaps_total: dataGaps.length,
    has_data: lateEvents.length > 0,
    has_activity: firstArrivals.length > 0 || dataGaps.length > 0 || lateEvents.length > 0,
  };
}

function createDailyBucket(date) {
  return { date, events: [], dataGaps: [] };
}

function ensureStudentBucket(map, item) {
  const id = String(item.student_id || item.studentId || '');
  if (!id) throw new Error('Late analytics student_id is required');
  if (!map.has(id)) {
    map.set(id, {
      student_id: id,
      student_name: item.student_name || item.name || '',
      class_id: String(item.class_id || item.classId || ''),
      class_name: item.class_name || item.className || '',
      arrivalDays: new Set(),
      events: [],
      dataGaps: [],
      subjectKeys: new Set(),
    });
  }
  return map.get(id);
}

function ensureSubjectBucket(map, lesson) {
  const key = lesson.subject_id || lesson.subject_name;
  if (!map.has(key)) {
    map.set(key, {
      subject_id: lesson.subject_id,
      subject_name: lesson.subject_name,
      subject_type: lesson.subject_type,
      lessons: [],
    });
  }
  return map.get(key);
}

function buildLatenessClassRows(studentRows) {
  const buckets = new Map();
  for (const student of studentRows || []) {
    const classId = String(student.class_id || '');
    if (!buckets.has(classId)) {
      buckets.set(classId, {
        class_id: classId,
        class_name: student.class_name || '',
        students: [],
        arrival_days: 0,
        late_days: 0,
        total_late_minutes: 0,
        missed_lessons: 0,
        data_gaps: 0,
      });
    }
    const bucket = buckets.get(classId);
    bucket.students.push(student);
    bucket.arrival_days += Number(student.arrival_days || 0);
    bucket.late_days += Number(student.late_days || 0);
    bucket.total_late_minutes += Number(student.total_late_minutes || 0);
    bucket.missed_lessons += Number(student.missed_lessons || 0);
    bucket.data_gaps += Number(student.data_gaps || 0);
  }

  return Array.from(buckets.values()).map((bucket) => {
    const lateStudents = bucket.students.filter((student) => Number(student.late_days || 0) > 0).length;
    const arrivedStudents = bucket.students.filter((student) => student.status_code === 'arrived').length;
    const gapStudents = bucket.students.filter((student) => student.status_code === 'gap').length;
    bucket.students = bucket.students.toSorted(compareStudentRows);
    return {
      ...bucket,
      students_total: bucket.students.length,
      students_late: lateStudents,
      students_arrived: arrivedStudents,
      students_gap: gapStudents,
      late_percent: percentOf(bucket.late_days, bucket.arrival_days),
    };
  }).sort(compareClassRows);
}

function latenessStudentStatus({ lateDays, arrivalDays, dataGaps }) {
  if (lateDays > 0) {
    return {
      code: 'late',
      label: 'Опоздал',
      className: 'bg-amber-100 text-amber-800',
    };
  }
  if (dataGaps > 0) {
    return {
      code: 'gap',
      label: 'Нет расписания',
      className: 'bg-red-50 text-red-700',
    };
  }
  if (arrivalDays > 0) {
    return {
      code: 'arrived',
      label: 'Вовремя',
      className: 'bg-emerald-50 text-emerald-700',
    };
  }
  return {
    code: 'none',
    label: 'Нет приходов',
    className: 'bg-gray-100 text-gray-600',
  };
}

function latenessStudentDetailLabel({ lateDays, arrivalDays, totalMinutes, missedLessons, dataGaps, lastLate }) {
  if (lateDays > 0) {
    const lessonPart = missedLessons ? `, уроков: ${missedLessons}` : '';
    return `${lastLate?.date_label || ''} ${totalMinutes} мин.${lessonPart}`.trim();
  }
  if (dataGaps > 0) {
    return `Пробелы расписания: ${dataGaps}`;
  }
  if (arrivalDays > 0) {
    return `Приходов: ${arrivalDays}, без опозданий`;
  }
  return '';
}

function compareArrivalRows(a, b) {
  return (
    String(a.attendance_date || '').localeCompare(String(b.attendance_date || '')) ||
    String(a.arrival_at || '').localeCompare(String(b.arrival_at || '')) ||
    String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true })
  );
}

function compareLateEvents(a, b) {
  return (
    String(a.date || '').localeCompare(String(b.date || '')) ||
    String(a.arrival_at || '').localeCompare(String(b.arrival_at || '')) ||
    String(a.student_name || '').localeCompare(String(b.student_name || ''), 'ru')
  );
}

function compareClassRows(a, b) {
  return String(a.class_name || '').localeCompare(String(b.class_name || ''), 'ru', { numeric: true, sensitivity: 'base' });
}

function compareStudentRows(a, b) {
  return (
    Number(b.late_days || 0) - Number(a.late_days || 0) ||
    Number(b.total_late_minutes || 0) - Number(a.total_late_minutes || 0) ||
    Number(b.missed_lessons || 0) - Number(a.missed_lessons || 0) ||
    String(a.class_name || '').localeCompare(String(b.class_name || ''), 'ru', { numeric: true, sensitivity: 'base' }) ||
    String(a.student_name || '').localeCompare(String(b.student_name || ''), 'ru', { numeric: true, sensitivity: 'base' })
  );
}

function compareSubjectRows(a, b) {
  return (
    Number(b.missed_lessons || 0) - Number(a.missed_lessons || 0) ||
    Number(b.students || 0) - Number(a.students || 0) ||
    String(a.subject_name || '').localeCompare(String(b.subject_name || ''), 'ru', { numeric: true, sensitivity: 'base' })
  );
}

function normalizeDateTime(value) {
  const ms = parseDateTimeMs(value);
  return Number.isFinite(ms) ? formatSqlDateTime(ms) : '';
}

function distinct(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}
