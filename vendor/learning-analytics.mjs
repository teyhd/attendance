import { percentOf } from './analytics.mjs';
import { isWithoutReasonCode } from './absence-reasons.mjs';
import { buildStudentLessonAnalytics } from './attendance-analytics-contract.mjs';
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
  presenceEvents = null,
  conflicts = [],
  lessonFacts = [],
  now = '',
} = {}) {
  if (!range) {
    return includeLessons ? { ...EMPTY_LEARNING, lessons: [] } : { ...EMPTY_LEARNING };
  }

  const studentById = buildStudentMap(students, periods);
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const publishedDaySet = new Set(publishedSchoolDays.map(dateOnly).filter(Boolean));
  const activeWeekdaySet = new Set((activeWeekdays || DEFAULT_ACTIVE_WEEKDAYS).map(Number));
  const missedLessons = [];
  const plannedLessons = [];
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
    let hasGap = false;

    for (const day of days) {
      if (!activeWeekdaySet.has(isoWeekday(day))) continue;
      if (!publishedDaySet.has(day)) {
        hasGap = true;
        dataGaps.push(createDataGap(period, student, day));
        continue;
      }

      const lessons = lessonsForStudentDay(scheduleIndex, period, student, day);
      if (!lessons.length) {
        hasGap = true;
        dataGaps.push({ ...createDataGap(period, student, day), code: 'no_student_schedule', message: 'Нет опубликованных уроков ученика' });
      }
    }

    if (hasGap) {
      uncoveredPeriodIds.add(periodId);
    }
  }

  for (const student of studentById.values()) {
    const projection = buildStudentLessonAnalytics({ range, student, periods, presenceEvents: presenceEvents || [], conflicts, lessonFacts, scheduleIndex, publishedSchoolDays, activeWeekdays, now });
    if (presenceEvents !== null) for (const day of projection.quality.missingScheduleDates) {
      if (dataGaps.some(gap => gap.student_id === student.student_id && gap.date === day)) continue;
      const gap = createDataGap({ student_id: student.student_id, class_id: student.class_id }, student, day);
      if (publishedDaySet.has(day)) Object.assign(gap, { code: 'no_student_schedule', message: 'Нет опубликованных уроков ученика' });
      dataGaps.push(gap);
    }
    for (const result of projection._lessons) {
      // Period-only consumers retain their scope; UI callers provide the full presence evidence.
      const row = presenceEvents === null && !lessonFacts.length ? {
        ...result, missedMinutes: result.confirmedAbsenceMinutes, noMarkMinutes: 0,
        missedLessons: result.confirmedAbsenceMinutes > MISSED_LESSON_MIN_OVERLAP_MINUTES ? 1 : 0,
        reasonMinutes: result.reasonMinutes.filter(reason => reason.code !== 'no_mark'),
      } : result;
      if (row.missedMinutes > 0 || row.conflictMinutes > 0) missedLessons.push(createProjectionLesson(row, student));
    }
    plannedLessons.push(...projection._plannedLessons.map(row => createProjectionLesson(row, student)));
  }

  missedLessons.sort(compareMissedLessons);
  const learning = aggregateLearning({
    range,
    students,
    missedLessons,
    dataGaps,
    periodIds,
    uncoveredPeriodIds,
  });
  learning.metric_version = 2;
  learning.missed_lesson_threshold_minutes = MISSED_LESSON_MIN_OVERLAP_MINUTES;
  learning.affected_lessons_total = missedLessons.length;
  learning.planned_lessons_total = plannedLessons.length;
  learning.planned_absence_minutes = plannedLessons.reduce((sum, lesson) => sum + lesson.overlap_minutes, 0);
  learning.unconfirmed_lessons_total = missedLessons.filter(lesson => lesson.is_unconfirmed).length;
  learning.calculation_state = dataGaps.length ? 'partial' : (missedLessons.length || plannedLessons.length || scheduleRows.length) ? 'calculated' : 'no_schedule';

  if (includeLessons) {
    learning.lessons = missedLessons;
    learning.planned_lessons = plannedLessons.sort(compareMissedLessons);
  }

  return learning;
}

function createProjectionLesson(row, student) {
  const lesson = row.lesson;
  const reasons = row.reasonMinutes || [];
  const distinct = values => [...new Set(values.filter(Boolean))].join('; ');
  const planned = row.state === 'planned';
  const missedMinutes = Number(row.missedMinutes || 0);
  const lessonMinutes = (lesson.ends_ms - lesson.starts_ms) / 60_000;
  const isPartial = missedMinutes > 0 && missedMinutes < lessonMinutes;
  const isUnconfirmed = Number(row.noMarkMinutes || 0) > 0;
  const absenceIds = [...new Set(reasons.map(reason => reason.absenceId).filter(Boolean))];
  return {
    ...createMissedLesson({ id: absenceIds.join(','), student_id: student.student_id, class_id: student.class_id, reason_code: distinct(reasons.map(reason => reason.code)), reason_name: distinct(reasons.map(reason => reason.name)), comment: distinct(reasons.map(reason => reason.comment)), confirmation_status: distinct(reasons.map(reason => reason.confirmationStatus)), attention_status: reasons.some(reason => reason.attentionStatus === 'needs_attention') ? 'needs_attention' : 'normal' }, student, lesson, missedMinutes),
    id: `${student.student_id}:${lesson.entry_ids.join(',')}:${planned ? 'planned' : 'actual'}`,
    absence_ids: absenceIds,
    schedule_entry_ids: lesson.entry_ids,
    state: planned ? 'planned' : 'actual',
    attendance_status: row.conflictMinutes > 0 ? 'conflict' : isUnconfirmed ? 'unconfirmed_absence' : isPartial ? 'partial' : 'confirmed_absence',
    is_planned: planned,
    is_unconfirmed: isUnconfirmed,
    is_partial: isPartial,
    has_conflict: row.conflictMinutes > 0,
    counts_as_missed_lesson: !planned && missedMinutes > MISSED_LESSON_MIN_OVERLAP_MINUTES,
    overlap_minutes: missedMinutes,
    absence_minutes: missedMinutes,
    scheduled_minutes: row.scheduledMinutes,
    lesson_minutes: lessonMinutes,
    confirmed_absence_minutes: row.confirmedAbsenceMinutes,
    no_mark_minutes: row.noMarkMinutes,
    conflict_minutes: row.conflictMinutes,
    is_without_reason: reasons.some(reason => ['without_reason', 'no_mark'].includes(reason.code)),
  };
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
    absence_id: String(period.id || ''),
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
    absence_id: String(period.id || ''),
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

  const countMissed = lessons => lessons.filter(lesson => lesson.counts_as_missed_lesson !== false).length;
  const totalLessons = countMissed(missedLessons);
  const subjectRows = Array.from(subjectBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      subject_id: bucket.subject_id,
      subject_name: bucket.subject_name,
      subject_type: bucket.subject_type,
      missed_lessons: countMissed(bucket.lessons),
      affected_lessons: bucket.lessons.length,
      students: stats.students,
      days: stats.days,
      classes: stats.classes,
      percent: percentOf(countMissed(bucket.lessons), totalLessons),
      bar_width: percentOf(countMissed(bucket.lessons), totalLessons),
    };
  }).sort(compareLearningRows);

  const classRows = Array.from(classBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      class_id: bucket.class_id,
      class_name: bucket.class_name,
      missed_lessons: countMissed(bucket.lessons),
      affected_lessons: bucket.lessons.length,
      students: stats.students,
      subjects: stats.subjects,
      days: stats.days,
      data_gaps: bucket.dataGaps.length,
      href: `/attendance/analytics?class=${encodeURIComponent(bucket.class_id)}&month=${encodeURIComponent(range.month)}`,
      bar_width: percentOf(countMissed(bucket.lessons), totalLessons),
    };
  }).sort(compareLearningRows);

  const studentRows = Array.from(studentBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      student_id: bucket.student_id,
      student_name: bucket.student_name,
      class_id: bucket.class_id,
      class_name: bucket.class_name,
      missed_lessons: countMissed(bucket.lessons),
      affected_lessons: bucket.lessons.length,
      subjects: stats.subjects,
      days: stats.days,
      without_reason: bucket.lessons.filter((lesson) => lesson.is_without_reason).length,
      needs_attention: bucket.lessons.filter((lesson) => lesson.needs_attention).length,
      data_gaps: bucket.dataGaps.length,
      href: `/attendance?class=${encodeURIComponent(bucket.class_id)}&student=${encodeURIComponent(bucket.student_id)}&analyticsMonth=${encodeURIComponent(range.month)}#learning-analytics`,
      bar_width: percentOf(countMissed(bucket.lessons), totalLessons),
    };
  }).filter((row) => row.affected_lessons > 0 || row.data_gaps > 0)
    .sort(compareLearningRows);

  const dailyRows = Array.from(dailyBuckets.values()).map((bucket) => {
    const stats = lessonBucketStats(bucket.lessons);
    return {
      date: bucket.date,
      date_label: formatDateLabel(bucket.date),
      missed_lessons: countMissed(bucket.lessons),
      affected_lessons: bucket.lessons.length,
      students: stats.students,
      subjects: stats.subjects,
      data_gaps: bucket.dataGaps.length,
      bar_width: percentOf(countMissed(bucket.lessons), totalLessons),
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
    has_data: missedLessons.length > 0,
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
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];

  const startDate = dateOnly(formatSqlDateTime(startMs));
  const endDate = dateOnly(formatSqlDateTime(endMs > startMs ? endMs - 1 : endMs));
  const days = [];
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}
