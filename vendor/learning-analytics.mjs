import { percentOf } from './analytics.mjs';
import { isWithoutReasonCode } from './absence-reasons.mjs';
import {
  DEFAULT_ACTIVE_WEEKDAYS,
  addDays,
  buildScheduleIndex,
  dateOnly,
  formatDateLabel,
  formatMinutes,
  formatSqlDateTime,
  isoWeekday,
  lessonsForStudentDay,
  parseDateTimeMs,
  isHistoricalScheduleGap,
} from './schedule-analytics.mjs';

export const MISSED_LESSON_MIN_OVERLAP_MINUTES = 15;

const EMPTY_LEARNING = {
  missed_lessons_total: 0,
  students_with_missed_lessons: 0,
  subjects_total: 0,
  days_with_missed_lessons: 0,
  covered_absence_periods: 0,
  uncovered_absence_periods: 0,
  coverage_percent: 100,
  subjects: [],
  classes: [],
  students: [],
  daily: [],
  data_gaps: [],
  data_gaps_total: 0,
  conflict_lessons_total: 0,
  has_data: false,
};

export function buildLearningAnalytics({
  range,
  students = [],
  periods = [],
  scheduleRows = [],
  publishedSchoolDays = [],
  activeWeekdays = DEFAULT_ACTIVE_WEEKDAYS,
  includeLessons = false,
  now = '',
  scheduleCoverageFrom = '',
} = {}) {
  if (!range) {
    return includeLessons ? { ...EMPTY_LEARNING, lessons: [], confirmed_lessons: [], planned_lessons: [] } : { ...EMPTY_LEARNING };
  }

  const studentById = buildStudentMap(students, periods);
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const publishedDaySet = new Set(publishedSchoolDays.map(dateOnly).filter(Boolean));
  const activeWeekdaySet = new Set((activeWeekdays || DEFAULT_ACTIVE_WEEKDAYS).map(Number));
  const actual = new Map();
  const planned = new Map();
  const rangeStart = parseDateTimeMs(range.start_at);
  const rangeEnd = parseDateTimeMs(range.end_at);
  const nowMs = parseDateTimeMs(now || range.end_at);
  const dataGaps = [];
  const periodIds = new Set();
  const uncoveredPeriodIds = new Set();

  for (const period of periods) {
    if (period.deleted_at || period.cancelled_at) continue;
    const periodId = String(period.id || '');
    if (!periodId) continue;
    periodIds.add(periodId);

    const student = studentById.get(String(period.student_id)) || period;
    const days = expandPeriodDaysWithinRange(period, range);
    const start = Math.max(rangeStart, parseDateTimeMs(period.starts_at));
    const end = Math.min(rangeEnd, parseDateTimeMs(period.ends_at || range.end_at));
    let hasGap = false;

    for (const day of days) {
      const hasAssignments = scheduleIndex.assignmentsByStudentDay.has(`${student.student_id}|${day}`);
      if (!activeWeekdaySet.has(isoWeekday(day)) && !hasAssignments) continue;
      const historicalGap = isHistoricalScheduleGap(day, [period], scheduleCoverageFrom);
      if (historicalGap) {
        hasGap = true;
        dataGaps.push({ ...createDataGap(period, student, day), code: 'unverified_historical_schedule', message: 'Исторические назначения не подтверждены' });
      }
      if (!publishedDaySet.has(day) && !hasAssignments) {
        hasGap = true;
        if (!historicalGap) dataGaps.push(createDataGap(period, student, day));
        continue;
      }

      for (const lesson of lessonsForStudentDay(scheduleIndex, period, student, day)) {
        if (historicalGap && !lesson.assignment_key) continue;
        const from = Math.max(start, lesson.starts_ms);
        const to = Math.min(end, lesson.ends_ms);
        recordOverlap(actual, period, student, lesson, from, Math.min(to, nowMs));
        recordOverlap(planned, period, student, lesson, Math.max(from, nowMs), to);
      }
    }

    if (hasGap) {
      uncoveredPeriodIds.add(periodId);
    }
  }

  const confirmedLessons = summarizeOverlaps(actual, false);
  const missedLessons = confirmedLessons.filter((lesson) => lesson.counts_as_confirmed_missed_lesson);
  const plannedLessons = summarizeOverlaps(planned, true);
  const learning = aggregateLearning({
    range,
    students,
    missedLessons,
    dataGaps,
    periodIds,
    uncoveredPeriodIds,
  });
  learning.confirmed_missed_lessons_total = missedLessons.length;
  learning.confirmed_absence_minutes = confirmedLessons.reduce((sum, lesson) => sum + lesson.confirmed_absence_minutes, 0);
  learning.planned_lessons_total = plannedLessons.length;
  learning.historical_schedule_gap_dates = [...new Set(dataGaps.filter((gap) => gap.code === 'unverified_historical_schedule').map((gap) => gap.date))]
    .sort().map((date) => ({ date, date_label: formatDateLabel(date) }));

  if (includeLessons) {
    learning.lessons = missedLessons;
    learning.confirmed_lessons = confirmedLessons;
    learning.planned_lessons = plannedLessons;
  }

  return learning;
}

function recordOverlap(groups, period, student, lesson, start, end) {
  if (!(end > start)) return;
  const key = JSON.stringify([student.student_id, lesson.date, lesson.slot_id, lesson.starts_ms, lesson.ends_ms, lesson.subject_key]);
  if (!groups.has(key)) groups.set(key, { key, student, lesson, periods: [], intervals: [] });
  const group = groups.get(key);
  group.periods.push(period);
  group.intervals.push({ start, end });
}

function summarizeOverlaps(groups, isPlanned) {
  return [...groups.values()].map(({ key, student, lesson, periods, intervals }) => {
    const ordered = intervals.sort((a, b) => a.start - b.start);
    let coveredThrough = Number.NEGATIVE_INFINITY;
    let coveredMs = 0;
    for (const { start, end } of ordered) {
      coveredMs += Math.max(0, end - Math.max(start, coveredThrough));
      coveredThrough = Math.max(coveredThrough, end);
    }
    const minutes = coveredMs / 60_000;
    const period = periods[0];
    const distinct = (values) => [...new Set(values.filter(Boolean))].join(' · ');
    return {
      ...createMissedLesson(period, student, lesson, minutes),
      id: periods.length === 1 ? `${period.id}:${lesson.assignment_key || lesson.entry_ids.join(',')}` : key,
      reason_name: distinct(periods.map((item) => item.reason_name || item.reason_code)),
      comment: distinct(periods.map((item) => item.comment)),
      is_planned: isPlanned,
      confirmed_absence_minutes: isPlanned ? 0 : minutes,
      counts_as_confirmed_missed_lesson: !isPlanned && minutes > MISSED_LESSON_MIN_OVERLAP_MINUTES,
      partial_confirmed_absence: coveredMs < lesson.ends_ms - lesson.starts_ms,
      removed_from_schedule: lesson.release_state === 'full',
    };
  }).sort(compareMissedLessons);
}

function buildStudentMap(students, periods) {
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
  for (const period of periods || []) {
    const id = String(period.student_id || '');
    if (!id || map.has(id)) continue;
    map.set(id, {
      student_id: id,
      student_name: period.student_name || '',
      class_id: String(period.class_id || ''),
      class_name: period.class_name || '',
    });
  }
  return map;
}

function createMissedLesson(period, student, lesson, overlapMinutes) {
  return {
    id: `${period.id}:${lesson.entry_ids.join(',')}`,
    absence_id: String(period.id),
    student_id: String(period.student_id),
    student_name: student.student_name || period.student_name || '',
    class_id: String(period.class_id || student.class_id || ''),
    class_name: student.class_name || period.class_name || lesson.class_name || '',
    date: lesson.date,
    date_label: formatDateLabel(lesson.date),
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
    activity_type: lesson.activity_type,
    slot_part: lesson.slot_part,
    is_paid: lesson.is_paid,
    lesson_type_id: lesson.lesson_type_id,
    reason_code: period.reason_code || '',
    reason_name: period.reason_name || period.reason_code || '',
    comment: period.comment || '',
    confirmation_status: period.confirmation_status || '',
    attention_status: period.attention_status || '',
    needs_attention: period.attention_status === 'needs_attention',
    is_without_reason: isWithoutReasonCode(period.reason_code),
    overlap_minutes: Math.round(overlapMinutes),
    overlap_label: formatMinutes(overlapMinutes),
    has_conflict: Boolean(lesson.has_conflict),
    conflict_subjects: lesson.conflict_subjects || '',
    source_scope: lesson.scope,
  };
}

function createDataGap(period, student, day) {
  return {
    absence_id: String(period.id),
    student_id: String(period.student_id),
    student_name: student.student_name || period.student_name || '',
    class_id: String(period.class_id || student.class_id || ''),
    class_name: student.class_name || period.class_name || '',
    date: day,
    date_label: formatDateLabel(day),
    reason_name: period.reason_name || period.reason_code || '',
    starts_at: period.starts_at || '',
    ends_at: period.ends_at || '',
    code: 'no_published_schedule',
    message: 'Нет опубликованного расписания',
  };
}

function aggregateLearning({
  range,
  students,
  missedLessons,
  dataGaps,
  periodIds,
  uncoveredPeriodIds,
}) {
  const subjectBuckets = new Map();
  const classBuckets = new Map();
  const studentBuckets = new Map();
  const dailyBuckets = new Map((range.days || []).map((day) => [day, createLearningDailyBucket(day)]));
  let conflictLessonsTotal = 0;

  for (const lesson of missedLessons) {
    if (lesson.has_conflict) conflictLessonsTotal += 1;
    ensureSubjectBucket(subjectBuckets, lesson).lessons.push(lesson);
    ensureClassLearningBucket(classBuckets, lesson).lessons.push(lesson);
    ensureStudentLearningBucket(studentBuckets, lesson).lessons.push(lesson);
    const dailyBucket = dailyBuckets.get(lesson.date) || createLearningDailyBucket(lesson.date);
    dailyBucket.lessons.push(lesson);
    dailyBuckets.set(lesson.date, dailyBucket);
  }

  for (const gap of dataGaps) {
    ensureClassLearningBucket(classBuckets, gap).dataGaps.push(gap);
    ensureStudentLearningBucket(studentBuckets, gap).dataGaps.push(gap);
    const dailyBucket = dailyBuckets.get(gap.date) || createLearningDailyBucket(gap.date);
    dailyBucket.dataGaps.push(gap);
    dailyBuckets.set(gap.date, dailyBucket);
  }

  for (const student of students || []) {
    const id = String(student.student_id || student.id || '');
    if (!id) continue;
    if (!studentBuckets.has(id)) {
      studentBuckets.set(id, {
        student_id: id,
        student_name: student.student_name || student.name || '',
        class_id: String(student.class_id || student.classId || ''),
        class_name: student.class_name || student.className || '',
        lessons: [],
        dataGaps: [],
      });
    }
  }

  const totalLessons = missedLessons.length;
  const subjectRows = Array.from(subjectBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      subject_id: bucket.subject_id,
      subject_name: bucket.subject_name,
      subject_type: bucket.subject_type,
      missed_lessons: bucket.lessons.length,
      students: stats.students,
      days: stats.days,
      classes: stats.classes,
      percent: percentOf(bucket.lessons.length, totalLessons),
      bar_width: percentOf(bucket.lessons.length, totalLessons),
    };
  }).sort(compareLearningRows);

  const classRows = Array.from(classBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      class_id: bucket.class_id,
      class_name: bucket.class_name,
      missed_lessons: bucket.lessons.length,
      students: stats.students,
      subjects: stats.subjects,
      days: stats.days,
      data_gaps: bucket.dataGaps.length,
      href: `/attendance/analytics?class=${encodeURIComponent(bucket.class_id)}&month=${encodeURIComponent(range.month)}`,
      bar_width: percentOf(bucket.lessons.length, totalLessons),
    };
  }).sort(compareLearningRows);

  const studentRows = Array.from(studentBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      student_id: bucket.student_id,
      student_name: bucket.student_name,
      class_id: bucket.class_id,
      class_name: bucket.class_name,
      missed_lessons: bucket.lessons.length,
      subjects: stats.subjects,
      days: stats.days,
      without_reason: bucket.lessons.filter((lesson) => lesson.is_without_reason).length,
      needs_attention: bucket.lessons.filter((lesson) => lesson.needs_attention).length,
      data_gaps: bucket.dataGaps.length,
      href: `/attendance?class=${encodeURIComponent(bucket.class_id)}&student=${encodeURIComponent(bucket.student_id)}&analyticsMonth=${encodeURIComponent(range.month)}#learning-analytics`,
      bar_width: percentOf(bucket.lessons.length, totalLessons),
    };
  }).filter((row) => row.missed_lessons > 0 || row.data_gaps > 0)
    .sort(compareLearningRows);

  const dailyRows = Array.from(dailyBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      date: bucket.date,
      date_label: formatDateLabel(bucket.date),
      missed_lessons: bucket.lessons.length,
      students: stats.students,
      subjects: stats.subjects,
      data_gaps: bucket.dataGaps.length,
      bar_width: percentOf(bucket.lessons.length, totalLessons),
    };
  });

  const totalPeriods = periodIds.size;
  const uncoveredAbsencePeriods = uncoveredPeriodIds.size;
  const coveredAbsencePeriods = Math.max(0, totalPeriods - uncoveredAbsencePeriods);

  return {
    missed_lessons_total: totalLessons,
    students_with_missed_lessons: studentRows.filter((row) => row.missed_lessons > 0).length,
    subjects_total: subjectRows.length,
    days_with_missed_lessons: dailyRows.filter((row) => row.missed_lessons > 0).length,
    covered_absence_periods: coveredAbsencePeriods,
    uncovered_absence_periods: uncoveredAbsencePeriods,
    coverage_percent: totalPeriods ? percentOf(coveredAbsencePeriods, totalPeriods) : 100,
    subjects: subjectRows,
    classes: classRows,
    students: studentRows,
    daily: dailyRows,
    data_gaps: dataGaps,
    data_gaps_total: dataGaps.length,
    conflict_lessons_total: conflictLessonsTotal,
    has_data: totalLessons > 0,
  };
}

function createLearningDailyBucket(date) {
  return { date, lessons: [], dataGaps: [] };
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

function ensureClassLearningBucket(map, item) {
  const id = String(item.class_id || '');
  if (!map.has(id)) {
    map.set(id, {
      class_id: id,
      class_name: item.class_name || '',
      lessons: [],
      dataGaps: [],
    });
  }
  return map.get(id);
}

function ensureStudentLearningBucket(map, item) {
  const id = String(item.student_id || '');
  if (!map.has(id)) {
    map.set(id, {
      student_id: id,
      student_name: item.student_name || '',
      class_id: String(item.class_id || ''),
      class_name: item.class_name || '',
      lessons: [],
      dataGaps: [],
    });
  }
  return map.get(id);
}

function lessonBucketStats(lessons) {
  return {
    students: new Set(lessons.map((lesson) => lesson.student_id)).size,
    subjects: new Set(lessons.map((lesson) => lesson.subject_id || lesson.subject_name)).size,
    classes: new Set(lessons.map((lesson) => lesson.class_id)).size,
    days: new Set(lessons.map((lesson) => lesson.date)).size,
  };
}

function compareLearningRows(a, b) {
  return (
    Number(b.missed_lessons || 0) - Number(a.missed_lessons || 0) ||
    Number(b.data_gaps || 0) - Number(a.data_gaps || 0) ||
    String(a.class_name || '').localeCompare(String(b.class_name || ''), 'ru', { numeric: true, sensitivity: 'base' }) ||
    String(a.student_name || a.subject_name || '').localeCompare(String(b.student_name || b.subject_name || ''), 'ru', { numeric: true, sensitivity: 'base' })
  );
}

function compareMissedLessons(a, b) {
  return (
    String(a.date).localeCompare(String(b.date)) ||
    Number(a.lesson_number || 0) - Number(b.lesson_number || 0) ||
    String(a.starts_at || '').localeCompare(String(b.starts_at || '')) ||
    String(a.subject_name || '').localeCompare(String(b.subject_name || ''), 'ru')
  );
}

function expandPeriodDaysWithinRange(period, range) {
  const startMs = Math.max(parseDateTimeMs(period.starts_at), parseDateTimeMs(range.start_at));
  const endMs = Math.min(parseDateTimeMs(period.ends_at || range.end_at), parseDateTimeMs(range.end_at));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const startDate = dateOnly(formatSqlDateTime(startMs));
  const endDate = dateOnly(formatSqlDateTime(endMs - 1));
  const days = [];
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}
