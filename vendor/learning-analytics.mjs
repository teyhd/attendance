import { percentOf } from './analytics.mjs';
import { isWithoutReasonCode } from './absence-reasons.mjs';

export const MISSED_LESSON_MIN_OVERLAP_MINUTES = 15;

const DEFAULT_ACTIVE_WEEKDAYS = [1, 2, 3, 4, 5];
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
} = {}) {
  if (!range) {
    return includeLessons ? { ...EMPTY_LEARNING, lessons: [] } : { ...EMPTY_LEARNING };
  }

  const studentById = buildStudentMap(students, periods);
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const publishedDaySet = new Set(publishedSchoolDays.map(dateOnly).filter(Boolean));
  const activeWeekdaySet = new Set((activeWeekdays || DEFAULT_ACTIVE_WEEKDAYS).map(Number));
  const missedLessons = [];
  const dataGaps = [];
  const periodIds = new Set();
  const uncoveredPeriodIds = new Set();

  for (const period of periods) {
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

      for (const lesson of lessonsForStudentDay(scheduleIndex, period, student, day)) {
        const overlapMinutes = overlapMinutesForPeriod(period, lesson, range);
        if (overlapMinutes <= MISSED_LESSON_MIN_OVERLAP_MINUTES) continue;
        missedLessons.push(createMissedLesson(period, student, lesson, overlapMinutes));
      }
    }

    if (hasGap) {
      uncoveredPeriodIds.add(periodId);
    }
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

  if (includeLessons) {
    learning.lessons = missedLessons;
  }

  return learning;
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

function buildScheduleIndex(rows) {
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

function lessonsForStudentDay(index, period, student, day) {
  const studentId = String(period.student_id || student.student_id || '');
  const classId = String(period.class_id || student.class_id || '');
  const individual = index.byStudentDay.get(`${studentId}|${day}`) || [];
  const classLessons = index.byClassDay.get(`${classId}|${day}`) || [];
  const filteredClassLessons = classLessons.filter((classLesson) => (
    !individual.some((studentLesson) => sameSlotOverlap(studentLesson, classLesson))
  ));
  return dedupeAndMarkConflicts([...individual, ...filteredClassLessons]);
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

function compareLessons(a, b) {
  return (
    String(a.date).localeCompare(String(b.date)) ||
    Number(a.starts_ms || 0) - Number(b.starts_ms || 0) ||
    Number(a.lesson_number || 0) - Number(b.lesson_number || 0) ||
    String(a.subject_name || '').localeCompare(String(b.subject_name || ''), 'ru')
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

function sameSlotOverlap(a, b) {
  return String(a.slot_id) === String(b.slot_id) && a.starts_ms < b.ends_ms && a.ends_ms > b.starts_ms;
}

function overlapMinutesForPeriod(period, lesson, range) {
  const periodStartMs = Math.max(parseDateTimeMs(period.starts_at), parseDateTimeMs(range.start_at));
  const periodEndMs = Math.min(parseDateTimeMs(period.ends_at || range.end_at), parseDateTimeMs(range.end_at));
  if (!Number.isFinite(periodStartMs) || !Number.isFinite(periodEndMs) || periodEndMs <= periodStartMs) return 0;
  const from = Math.max(periodStartMs, lesson.starts_ms);
  const to = Math.min(periodEndMs, lesson.ends_ms);
  return to > from ? (to - from) / 60_000 : 0;
}

function expandPeriodDaysWithinRange(period, range) {
  const startMs = Math.max(parseDateTimeMs(period.starts_at), parseDateTimeMs(range.start_at));
  const endMs = Math.min(parseDateTimeMs(period.ends_at || range.end_at), parseDateTimeMs(range.end_at));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];

  const startDate = dateOnly(formatSqlDateTime(startMs));
  const endDate = dateOnly(formatSqlDateTime(endMs));
  const days = [];
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
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

function parseDateTimeMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function formatSqlDateTime(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

function formatTimeRange(startsAt, endsAt) {
  return `${String(startsAt).slice(11, 16)}-${String(endsAt).slice(11, 16)}`;
}

function formatDateLabel(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : String(value || '');
}

function formatMinutes(value) {
  const minutes = Math.round(Number(value || 0));
  return `${minutes} мин.`;
}

function joinDistinct(left, right) {
  const values = new Set(String(left || '').split(', ').filter(Boolean));
  if (right) values.add(String(right));
  return Array.from(values).join(', ');
}

function dateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function isoWeekday(dateText) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function addDays(dateText, amount) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
