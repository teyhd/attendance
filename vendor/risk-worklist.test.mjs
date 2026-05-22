import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthRange } from './analytics.mjs';
import { buildRiskWorklist } from './risk-worklist.mjs';

const range = buildMonthRange('2026-05');

const periods = [
  {
    id: '1',
    student_id: '10',
    student_name: 'Анна Сергеева',
    class_id: '5',
    class_name: '5',
    starts_at: '2026-05-10 08:00:00',
    ends_at: '2026-05-10 12:00:00',
    reason_code: 'without_reason',
    reason_name: 'Без причины',
    confirmation_status: 'needs_clarification',
    attention_status: 'needs_attention',
    comment: 'нет данных',
  },
  {
    id: '2',
    student_id: '20',
    student_name: 'Борис Иванов',
    class_id: '6',
    class_name: '6',
    starts_at: '2026-05-12 09:00:00',
    ends_at: '2026-05-12 14:00:00',
    reason_code: 'illness',
    reason_name: 'Болезнь',
    confirmation_status: 'confirmed',
    attention_status: 'normal',
    comment: '',
  },
  {
    id: '3',
    student_id: '30',
    student_name: 'София Петрова',
    class_id: '7',
    class_name: '7',
    starts_at: '2026-05-08 08:00:00',
    ends_at: '2026-05-09 23:59:00',
    reason_code: 'trip',
    reason_name: 'Поездка',
    confirmation_status: 'confirmed',
    attention_status: 'normal',
    comment: 'соревнования',
  },
];

const learning = {
  students: [
    {
      student_id: '20',
      student_name: 'Борис Иванов',
      class_id: '6',
      class_name: '6',
      missed_lessons: 3,
      subjects: 2,
      days: 1,
      data_gaps: 0,
    },
    {
      student_id: '30',
      student_name: 'София Петрова',
      class_id: '7',
      class_name: '7',
      missed_lessons: 0,
      subjects: 0,
      days: 0,
      data_gaps: 1,
    },
  ],
};

const lateness = {
  students: [
    {
      student_id: '40',
      student_name: 'Данил Смирнов',
      class_id: '8',
      class_name: '8',
      arrival_days: 4,
      late_days: 2,
      late_percent: 50,
      total_late_minutes: 24,
      missed_lessons: 1,
      subjects: 1,
      data_gaps: 0,
      last_late_at: '2026-05-14 09:12:00',
      last_late_label: '14.05.2026 09:12, 12 мин.',
    },
  ],
};

test('risk worklist filters by risk type', () => {
  const attention = buildRiskWorklist({ range, periods, learning, filters: { risk: 'attention' } });
  assert.deepEqual(attention.items.map((row) => row.student_id), ['10']);

  const lessons = buildRiskWorklist({ range, periods, learning, filters: { risk: 'missed_lessons' } });
  assert.deepEqual(lessons.items.map((row) => row.student_id), ['20']);
});

test('risk worklist filters by reason and search query', () => {
  const byReason = buildRiskWorklist({ range, periods, learning, filters: { reason: 'trip' } });
  assert.deepEqual(byReason.items.map((row) => row.student_id), ['30']);

  const byQuery = buildRiskWorklist({ range, periods, learning, filters: { q: 'борис' } });
  assert.deepEqual(byQuery.items.map((row) => row.student_id), ['20']);
});

test('risk worklist supports all configured sort modes', () => {
  const latest = buildRiskWorklist({ range, periods, learning, filters: { sort: 'latest' } });
  assert.equal(latest.items[0].student_id, '20');

  const days = buildRiskWorklist({ range, periods, learning, filters: { sort: 'days' } });
  assert.equal(days.items[0].student_id, '30');

  const lessons = buildRiskWorklist({ range, periods, learning, filters: { sort: 'lessons' } });
  assert.equal(lessons.items[0].student_id, '20');

  const name = buildRiskWorklist({ range, periods, learning, filters: { sort: 'name' } });
  assert.deepEqual(name.items.map((row) => row.student_name), ['Анна Сергеева', 'Борис Иванов', 'София Петрова']);
});

test('student with data gaps and no missed lessons is included in schedule gap filter', () => {
  const worklist = buildRiskWorklist({ range, periods, learning, filters: { risk: 'schedule_gap' } });
  assert.deepEqual(worklist.items.map((row) => row.student_id), ['30']);
  assert.equal(worklist.items[0].missed_lessons, 0);
  assert.equal(worklist.items[0].data_gaps, 1);
});

test('lateness is included as risk signal and sort mode', () => {
  const byLate = buildRiskWorklist({ range, periods, learning, lateness, filters: { risk: 'late' } });
  assert.deepEqual(byLate.items.map((row) => row.student_id), ['40']);
  assert.equal(byLate.items[0].late_days, 2);
  assert.equal(byLate.items[0].late_minutes, 24);

  const sorted = buildRiskWorklist({ range, periods, learning, lateness, filters: { sort: 'late_minutes' } });
  assert.equal(sorted.items[0].student_id, '40');
});
