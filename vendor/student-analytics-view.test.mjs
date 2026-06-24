import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeStudentMonthlyAnalytics } from './student-analytics-view.mjs';

test('student analytics sanitizer removes staff-only fields and keeps own attendance data', () => {
  const result = sanitizeStudentMonthlyAnalytics({
    month: '2026-05',
    month_label: 'май 2026',
    period: { from: '2026-05-01', to: '2026-05-31', days_count: 31 },
    student: {
      id: '10',
      name: 'Student',
      class_id: '5',
      class_name: '5',
      href: '/attendance?class=5&student=10',
    },
    kpi: {
      periods: 2,
      absence_days: 2,
      without_reason: 1,
      needs_attention: 1,
      needs_clarification: 1,
      missed_lessons: 3,
      data_gaps: 0,
      late_days: 1,
      late_minutes: 7,
      late_missed_lessons: 1,
      present_days: 10,
      school_days_total: 18,
      excused_absence_days: 1,
      unexcused_absence_days: 1,
      incomplete_days: 1,
    },
    attendance: {
      student_id: '10',
      student_name: 'Student',
      class_id: '5',
      class_name: '5',
      school_days_total: 18,
      present_days: 10,
      absence_days: 2,
      excused_absence_days: 1,
      unexcused_absence_days: 1,
      incomplete_days: 1,
      metric_label: '10/18 присутствовал',
      days: [{
        date: '2026-05-04',
        date_label: '04.05.2026',
        status_code: 'present',
        status_label: 'был в школе',
        status_class: 'bg-emerald-50 text-emerald-700',
        arrival_time: '08:55',
        departure_time: '16:10',
        reason_label: '',
      }],
      absence_details: [{
        date: '2026-05-05',
        date_label: '05.05.2026',
        reason_label: 'Болезнь',
        comment_label: 'Комментарий',
        attention_status: 'needs_attention',
      }],
    },
    periods: [{
      id: 'p1',
      student_id: '10',
      class_id: '5',
      starts_at: '2026-05-05 09:00:00',
      ends_at: '2026-05-05 18:00:00',
      starts_at_input: '2026-05-05T09:00',
      period_label: '05.05',
      reason_code: 'illness',
      reason_name: 'Болезнь',
      is_without_reason: false,
      is_excused: true,
      confirmation_status: 'confirmed',
      confirmation_label: 'Подтверждено',
      attention_status: 'needs_attention',
      attention_label: 'Требует внимания',
      needs_attention: true,
      resolved_by: '99',
      created_by: '99',
      updated_by: '100',
      comment: 'Комментарий',
    }],
    learning: {
      missed_lessons_total: 3,
      data_gaps_total: 0,
      subjects_total: 1,
      has_data: true,
      subjects: [{ subject_id: 'math', subject_name: 'Math', missed_lessons: 3, bar_width: 100 }],
      lessons: [{
        id: 'lesson1',
        date: '2026-05-05',
        date_label: '05.05.2026',
        lesson_number: 1,
        time_label: '09:00-09:40',
        subject_id: 'math',
        subject_name: 'Math',
        teacher_name: 'Teacher',
        room_name: '101',
        reason_name: 'Болезнь',
        comment: 'Комментарий',
        has_conflict: true,
      }],
    },
    lateness: {
      late_days_total: 1,
      total_late_minutes: 7,
      events: [{
        date: '2026-05-06',
        date_label: '06.05.2026',
        arrival_time: '09:07',
        late_minutes: 7,
        missed_lessons: 1,
        missed_subject_names: 'Math',
        first_lesson_time: '09:00',
        first_lesson_number: 1,
        first_subject_name: 'Math',
        internal_note: 'staff only',
        missed_lessons_list: [{ time_label: '09:00-09:40', subject_name: 'Math', room_name: '101' }],
      }],
    },
    reason_options: [{ code: 'illness', name: 'Болезнь' }],
  });

  assert.equal(result.student.name, 'Student');
  assert.equal(result.student.href, undefined);
  assert.equal(result.kpi.present_days, 10);
  assert.equal(result.kpi.needs_attention, undefined);
  assert.equal(result.reason_options, undefined);
  assert.equal(result.periods[0].comment, 'Комментарий');
  assert.equal(result.learning.lessons[0].subject_name, 'Math');
  assert.equal(result.lateness.events[0].late_minutes, 7);

  for (const forbidden of [
    'href',
    'reason_options',
    'needs_attention',
    'needs_clarification',
    'attention_status',
    'attention_label',
    'confirmation_status',
    'confirmation_label',
    'resolved_by',
    'created_by',
    'updated_by',
    'starts_at_input',
    'internal_note',
    'has_conflict',
  ]) {
    assert.equal(hasOwnKeyDeep(result, forbidden), false, `${forbidden} leaked`);
  }
});

function hasOwnKeyDeep(value, key) {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  if (Array.isArray(value)) return value.some((item) => hasOwnKeyDeep(item, key));
  return Object.values(value).some((item) => hasOwnKeyDeep(item, key));
}
