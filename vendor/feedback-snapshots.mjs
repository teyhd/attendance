import {
  DEFAULT_ACTIVE_WEEKDAYS,
  addDays,
  buildScheduleIndex,
  dateOnly,
  isoWeekday,
  lessonsForStudentDay,
  overlapMinutesForPeriod,
} from './schedule-analytics.mjs';
import { MISSED_LESSON_MIN_OVERLAP_MINUTES } from './learning-analytics.mjs';

export const FEEDBACK_ATTENDANCE_ALGORITHM = 'attendance-feedback-v1';
export const MAX_FEEDBACK_RANGE_DAYS = 366;
export const MAX_FEEDBACK_ASSIGNMENTS = 3000;

export function buildFeedbackDateRange(periodStart, periodEnd) {
  const start = validDateOnly(periodStart);
  const end = validDateOnly(periodEnd);
  if (!start || !end) throw new TypeError('Некорректный период');
  if (start > end) throw new TypeError('Начало периода позже окончания');

  const days = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    days.push(current);
    if (days.length > MAX_FEEDBACK_RANGE_DAYS) throw new TypeError('Период слишком большой');
  }
  return {
    start_date: start,
    end_date: end,
    start_at: `${start} 00:00:00`,
    end_at: `${end} 23:59:59`,
    days,
    days_count: days.length,
  };
}

export function normalizeFeedbackAssignments(assignments) {
  if (!Array.isArray(assignments) || !assignments.length) {
    throw new TypeError('Не переданы назначения');
  }
  if (assignments.length > MAX_FEEDBACK_ASSIGNMENTS) {
    throw new TypeError('Слишком много назначений');
  }
  const normalized = assignments.map((item) => ({
    key: String(item?.key || '').trim(),
    studentId: positiveInteger(item?.studentId),
    subjectId: positiveInteger(item?.subjectId),
    teacherId: positiveInteger(item?.teacherId),
  }));
  if (normalized.some((item) => !item.key || !item.studentId || !item.subjectId || !item.teacherId)) {
    throw new TypeError('Некорректное назначение');
  }
  if (new Set(normalized.map((item) => item.key)).size !== normalized.length) {
    throw new TypeError('Ключи назначений должны быть уникальными');
  }
  return normalized;
}

export function buildFeedbackAttendanceSnapshots({
  range,
  assignments = [],
  students = [],
  periods = [],
  scheduleRows = [],
  publishedSchoolDays = [],
  activeWeekdays = DEFAULT_ACTIVE_WEEKDAYS,
  calculatedAt = new Date().toISOString(),
} = {}) {
  if (!range) throw new TypeError('Не передан период');
  const scheduleIndex = buildScheduleIndex(scheduleRows);
  const studentById = new Map(students.map((student) => [
    String(student.student_id || student.id),
    student,
  ]));
  const periodsByStudent = groupBy(periods, (period) => String(period.student_id || ''));
  const published = new Set(publishedSchoolDays.map(dateOnly).filter(Boolean));
  const active = new Set((activeWeekdays || DEFAULT_ACTIVE_WEEKDAYS).map(Number));
  const expectedDates = range.days.filter((day) => active.has(isoWeekday(day)));
  const coveredDates = expectedDates.filter((day) => published.has(day));
  const missingScheduleDates = expectedDates.filter((day) => !published.has(day));

  return assignments.map((assignment) => {
    const student = studentById.get(String(assignment.studentId));
    if (!student) return unavailableSnapshot(assignment.key, calculatedAt, 'student_not_found');

    const scheduledLessons = [];
    for (const day of coveredDates) {
      const lessons = lessonsForStudentDay(scheduleIndex, {
        student_id: assignment.studentId,
        class_id: student.class_id,
      }, student, day);
      for (const lesson of lessons) {
        if (String(lesson.subject_id) !== String(assignment.subjectId)) continue;
        scheduledLessons.push(lesson);
      }
    }

    const studentPeriods = periodsByStudent.get(String(assignment.studentId)) || [];
    const missed = [];
    for (const lesson of scheduledLessons) {
      const period = studentPeriods.find((candidate) => (
        overlapMinutesForPeriod(candidate, lesson, range) > MISSED_LESSON_MIN_OVERLAP_MINUTES
      ));
      if (period) {
        missed.push({
          date: lesson.date,
          lessonId: lesson.entry_ids.join(','),
          absenceId: String(period.id || ''),
        });
      }
    }

    const scheduledCount = scheduledLessons.length;
    const missedCount = missed.length;
    const coverageComplete = missingScheduleDates.length === 0;
    const state = !coverageComplete
      ? 'partial'
      : scheduledCount > 0
        ? 'complete'
        : 'no_schedule';

    return {
      key: assignment.key,
      state,
      scheduledLessons: scheduledCount,
      missedLessons: missedCount,
      attendancePercent: state === 'complete'
        ? roundPercent((scheduledCount - missedCount) / scheduledCount * 100)
        : null,
      coveredDays: coveredDates.length,
      expectedDays: expectedDates.length,
      algorithmVersion: FEEDBACK_ATTENDANCE_ALGORITHM,
      calculatedAt,
      details: {
        missingScheduleDates,
        missed,
        assignmentTeacherId: assignment.teacherId,
        thresholdMinutes: MISSED_LESSON_MIN_OVERLAP_MINUTES,
      },
    };
  });
}

function unavailableSnapshot(key, calculatedAt, reason) {
  return {
    key,
    state: 'unavailable',
    scheduledLessons: null,
    missedLessons: null,
    attendancePercent: null,
    coveredDays: 0,
    expectedDays: 0,
    algorithmVersion: FEEDBACK_ATTENDANCE_ALGORITHM,
    calculatedAt,
    details: { reason },
  };
}

function validDateOnly(value) {
  const normalized = dateOnly(value);
  if (!normalized || normalized !== String(value || '').slice(0, 10)) return '';
  const [year, month, day] = normalized.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() + 1 === month
    && candidate.getUTCDate() === day
    ? normalized
    : '';
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function groupBy(values, keyOf) {
  const result = new Map();
  for (const value of values || []) {
    const key = keyOf(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  }
  return result;
}

function roundPercent(value) {
  return Math.round(value * 100) / 100;
}
