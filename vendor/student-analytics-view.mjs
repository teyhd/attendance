export function sanitizeStudentMonthlyAnalytics(source = {}) {
  const kpi = source.kpi || {};
  return {
    month: source.month || '',
    month_label: source.month_label || '',
    period: sanitizePeriodRange(source.period),
    student: sanitizeStudent(source.student),
    kpi: {
      periods: number(kpi.periods),
      absence_days: number(kpi.absence_days),
      without_reason: number(kpi.without_reason),
      missed_lessons: number(kpi.missed_lessons),
      data_gaps: number(kpi.data_gaps),
      late_days: number(kpi.late_days),
      late_minutes: number(kpi.late_minutes),
      late_missed_lessons: number(kpi.late_missed_lessons),
      present_days: number(kpi.present_days),
      school_days_total: number(kpi.school_days_total),
      excused_absence_days: number(kpi.excused_absence_days),
      unexcused_absence_days: number(kpi.unexcused_absence_days),
      incomplete_days: number(kpi.incomplete_days),
    },
    attendance: sanitizeAttendance(source.attendance),
    periods: array(source.periods).map(sanitizeAbsencePeriod),
    learning: sanitizeLearning(source.learning),
    lateness: sanitizeLateness(source.lateness),
  };
}

function sanitizePeriodRange(period = {}) {
  return {
    from: period.from || '',
    to: period.to || '',
    days_count: number(period.days_count),
  };
}

function sanitizeStudent(student = {}) {
  return {
    id: string(student.id),
    name: student.name || '',
    class_id: string(student.class_id),
    class_name: student.class_name || '',
  };
}

function sanitizeAttendance(attendance = {}) {
  return {
    student_id: string(attendance.student_id),
    student_name: attendance.student_name || '',
    class_id: string(attendance.class_id),
    class_name: attendance.class_name || '',
    school_days_total: number(attendance.school_days_total),
    present_days: number(attendance.present_days),
    absence_days: number(attendance.absence_days),
    excused_absence_days: number(attendance.excused_absence_days),
    unexcused_absence_days: number(attendance.unexcused_absence_days),
    incomplete_days: number(attendance.incomplete_days),
    metric_label: attendance.metric_label || '',
    absence_button_label: attendance.absence_button_label || '',
    days: array(attendance.days).map(sanitizeAttendanceDay),
    absence_details: array(attendance.absence_details).map(sanitizeAbsenceDay),
  };
}

function sanitizeAttendanceDay(day = {}) {
  return {
    date: day.date || '',
    date_label: day.date_label || '',
    short_date_label: day.short_date_label || '',
    status_code: day.status_code || '',
    status_label: day.status_label || '',
    status_class: day.status_class || '',
    arrival_time: day.arrival_time || '',
    departure_time: day.departure_time || '',
    reason_label: day.reason_label || '',
    absence_state_label: day.absence_state_label || '',
    comment_label: day.comment_label || '',
    has_arrival: Boolean(day.has_arrival),
    has_absence: Boolean(day.has_absence),
    is_excused_absence: Boolean(day.is_excused_absence),
    is_unexcused_absence: Boolean(day.is_unexcused_absence),
    is_incomplete: Boolean(day.is_incomplete),
  };
}

function sanitizeAbsenceDay(day = {}) {
  return {
    date: day.date || '',
    date_label: day.date_label || '',
    short_date_label: day.short_date_label || '',
    status_label: day.status_label || '',
    reason_label: day.reason_label || '',
    absence_state_label: day.absence_state_label || '',
    comment_label: day.comment_label || '',
    is_excused: Boolean(day.is_excused),
    is_unexcused: Boolean(day.is_unexcused),
  };
}

function sanitizeAbsencePeriod(period = {}) {
  return {
    starts_at: period.starts_at || '',
    ends_at: period.ends_at || '',
    period_label: period.period_label || '',
    reason_code: period.reason_code || '',
    reason_name: period.reason_name || '',
    is_without_reason: Boolean(period.is_without_reason),
    is_excused: Boolean(period.is_excused),
    comment: period.comment || '',
  };
}

function sanitizeLearning(learning = {}) {
  return {
    missed_lessons_total: number(learning.missed_lessons_total),
    data_gaps_total: number(learning.data_gaps_total),
    uncovered_absence_periods: number(learning.uncovered_absence_periods),
    coverage_percent: number(learning.coverage_percent),
    subjects_total: number(learning.subjects_total),
    has_data: Boolean(learning.has_data),
    subjects: array(learning.subjects).map(sanitizeSubject),
    lessons: array(learning.lessons).map(sanitizeLesson),
  };
}

function sanitizeSubject(subject = {}) {
  return {
    subject_id: string(subject.subject_id),
    subject_name: subject.subject_name || '',
    subject_type: subject.subject_type || '',
    missed_lessons: number(subject.missed_lessons),
    days: number(subject.days),
    percent: number(subject.percent),
    bar_width: number(subject.bar_width),
  };
}

function sanitizeLesson(lesson = {}) {
  return {
    date: lesson.date || '',
    date_label: lesson.date_label || '',
    lesson_number: number(lesson.lesson_number),
    starts_at: lesson.starts_at || '',
    ends_at: lesson.ends_at || '',
    time_label: lesson.time_label || '',
    subject_id: string(lesson.subject_id),
    subject_name: lesson.subject_name || '',
    subject_type: lesson.subject_type || '',
    teacher_name: lesson.teacher_name || '',
    room_name: lesson.room_name || '',
    reason_name: lesson.reason_name || '',
    comment: lesson.comment || '',
  };
}

function sanitizeLateness(lateness = {}) {
  return {
    late_days_total: number(lateness.late_days_total),
    students_late_total: number(lateness.students_late_total),
    missed_lessons_total: number(lateness.missed_lessons_total),
    total_late_minutes: number(lateness.total_late_minutes),
    avg_late_minutes: number(lateness.avg_late_minutes),
    data_gaps_total: number(lateness.data_gaps_total),
    has_activity: Boolean(lateness.has_activity),
    events: array(lateness.events).map(sanitizeLateEvent),
  };
}

function sanitizeLateEvent(event = {}) {
  return {
    date: event.date || '',
    date_label: event.date_label || '',
    arrival_time: event.arrival_time || '',
    arrival_at: event.arrival_at || '',
    late_minutes: number(event.late_minutes),
    missed_lessons: number(event.missed_lessons),
    missed_subject_names: event.missed_subject_names || '',
    first_lesson_time: event.first_lesson_time || '',
    first_lesson_number: number(event.first_lesson_number),
    first_subject_name: event.first_subject_name || '',
    missed_lessons_list: array(event.missed_lessons_list).map(sanitizeLateMissedLesson),
  };
}

function sanitizeLateMissedLesson(lesson = {}) {
  return {
    lesson_number: number(lesson.lesson_number),
    time_label: lesson.time_label || '',
    subject_name: lesson.subject_name || '',
    teacher_name: lesson.teacher_name || '',
    room_name: lesson.room_name || '',
  };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function number(value) {
  return Number(value || 0);
}

function string(value) {
  return value == null ? '' : String(value);
}
