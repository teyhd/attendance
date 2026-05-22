import { expandDateRangeWithinMonth } from './analytics.mjs';
import { isWithoutReasonCode } from './absence-reasons.mjs';

const RISK_FILTERS = new Set(['all', 'attention', 'missing_reason', 'clarification', 'schedule_gap', 'missed_lessons', 'late']);
const RISK_SORTS = new Set(['priority', 'latest', 'days', 'lessons', 'late', 'late_minutes', 'name']);

export function normalizeRiskWorklistFilters(filters = {}) {
  const risk = RISK_FILTERS.has(String(filters.risk || '').trim())
    ? String(filters.risk).trim()
    : 'all';
  const sort = RISK_SORTS.has(String(filters.sort || '').trim())
    ? String(filters.sort).trim()
    : 'priority';
  return {
    risk,
    sort,
    reason: String(filters.reason || '').trim(),
    q: String(filters.q || '').trim(),
  };
}

export function buildRiskWorklist({ range, periods = [], learning = {}, lateness = {}, filters = {} } = {}) {
  const normalized = normalizeRiskWorklistFilters(filters);
  const buckets = new Map();
  const reasonBuckets = new Map();

  for (const period of periods || []) {
    const bucket = ensureBucket(buckets, period, range);
    const days = expandDateRangeWithinMonth(period.starts_at, period.ends_at || period.starts_at, range);
    bucket.periods += 1;
    bucket.period_ids.add(String(period.id || ''));
    for (const day of days) bucket.absence_days_set.add(`${bucket.student_id}|${day}`);

    const reasonCode = String(period.reason_code || '');
    if (reasonCode) {
      bucket.reason_codes.add(reasonCode);
      if (!reasonBuckets.has(reasonCode)) {
        reasonBuckets.set(reasonCode, {
          code: reasonCode,
          name: period.reason_name || reasonCode,
          count: 0,
        });
      }
      reasonBuckets.get(reasonCode).count += 1;
    }

    if (isWithoutReasonCode(period.reason_code)) bucket.without_reason += 1;
    if (period.confirmation_status === 'needs_clarification') bucket.needs_clarification += 1;
    if (period.attention_status === 'needs_attention') bucket.needs_attention += 1;

    if (!bucket.last_starts_at || String(period.starts_at || '') >= bucket.last_starts_at) {
      bucket.last_absence_id = String(period.id || '');
      bucket.last_starts_at = String(period.starts_at || '');
      bucket.last_ends_at = String(period.ends_at || '');
      bucket.last_reason = period.reason_name || period.reason_code || '';
      bucket.last_reason_code = period.reason_code || '';
      bucket.last_comment = period.comment || '';
      bucket.last_confirmation_status = period.confirmation_status || '';
      bucket.last_attention_status = period.attention_status || '';
    }
  }

  for (const row of learning?.students || []) {
    const bucket = ensureBucket(buckets, {
      student_id: row.student_id,
      student_name: row.student_name,
      class_id: row.class_id,
      class_name: row.class_name,
    }, range);
    bucket.missed_lessons = Number(row.missed_lessons || 0);
    bucket.subjects = Number(row.subjects || 0);
    bucket.learning_days = Number(row.days || 0);
    bucket.data_gaps = Number(row.data_gaps || 0);
  }

  for (const row of lateness?.students || []) {
    const bucket = ensureBucket(buckets, {
      student_id: row.student_id,
      student_name: row.student_name,
      class_id: row.class_id,
      class_name: row.class_name,
    }, range);
    bucket.late_days = Number(row.late_days || 0);
    bucket.late_arrival_days = Number(row.arrival_days || 0);
    bucket.late_percent = Number(row.late_percent || 0);
    bucket.late_minutes = Number(row.total_late_minutes || 0);
    bucket.late_missed_lessons = Number(row.missed_lessons || 0);
    bucket.late_subjects = Number(row.subjects || 0);
    bucket.late_data_gaps = Number(row.data_gaps || 0);
    bucket.last_late_at = row.last_late_at || '';
    bucket.last_late_date = row.last_late_date || '';
    bucket.last_late_time = row.last_late_time || '';
    bucket.last_late_label = row.last_late_label || '';
    if (!bucket.student_href || bucket.periods === 0) {
      bucket.student_href = `/attendance?class=${encodeURIComponent(bucket.class_id)}&student=${encodeURIComponent(bucket.student_id)}&analyticsMonth=${encodeURIComponent(range?.month || '')}#lateness-analytics`;
    }
  }

  const allRows = Array.from(buckets.values())
    .map((bucket) => finalizeBucket(bucket, range))
    .filter((row) => row.has_signal);

  const filteredRows = allRows
    .filter((row) => riskMatches(row, normalized.risk))
    .filter((row) => !normalized.reason || row.reason_codes.includes(normalized.reason))
    .filter((row) => searchMatches(row, normalized.q))
    .sort((a, b) => compareRiskRows(a, b, normalized.sort));

  const maxPriority = Math.max(0, ...filteredRows.map((row) => row.priority_score));
  for (const row of filteredRows) {
    row.bar_width = maxPriority ? Math.round((row.priority_score / maxPriority) * 100) : 0;
  }

  return {
    filters: normalized,
    filter_options: riskFilterOptions(normalized.risk),
    sort_options: riskSortOptions(normalized.sort),
    reason_options: Array.from(reasonBuckets.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'))
      .map((item) => ({ ...item, selected: item.code === normalized.reason })),
    total_count: allRows.length,
    filtered_count: filteredRows.length,
    items: filteredRows,
  };
}

function ensureBucket(map, item, range) {
  const studentId = String(item.student_id || item.studentId || item.id || '');
  if (!studentId) throw new Error('Risk worklist student_id is required');
  if (!map.has(studentId)) {
    const classId = String(item.class_id || item.classId || '');
    map.set(studentId, {
      student_id: studentId,
      student_name: item.student_name || item.name || '',
      class_id: classId,
      class_name: item.class_name || item.className || '',
      periods: 0,
      period_ids: new Set(),
      absence_days_set: new Set(),
      without_reason: 0,
      needs_attention: 0,
      needs_clarification: 0,
      missed_lessons: 0,
      subjects: 0,
      learning_days: 0,
      data_gaps: 0,
      late_days: 0,
      late_arrival_days: 0,
      late_percent: 0,
      late_minutes: 0,
      late_missed_lessons: 0,
      late_subjects: 0,
      late_data_gaps: 0,
      reason_codes: new Set(),
      last_absence_id: '',
      last_starts_at: '',
      last_ends_at: '',
      last_reason: '',
      last_reason_code: '',
      last_comment: '',
      last_confirmation_status: '',
      last_attention_status: '',
      last_late_at: '',
      last_late_date: '',
      last_late_time: '',
      last_late_label: '',
      student_href: `/attendance?class=${encodeURIComponent(classId)}&student=${encodeURIComponent(studentId)}&analyticsMonth=${encodeURIComponent(range?.month || '')}#learning-analytics`,
    });
  }
  return map.get(studentId);
}

function finalizeBucket(bucket, range) {
  const hasAttention = bucket.needs_attention > 0;
  const hasMissingReason = bucket.without_reason > 0;
  const hasClarification = bucket.needs_clarification > 0;
  const totalDataGaps = bucket.data_gaps + bucket.late_data_gaps;
  const hasScheduleGap = totalDataGaps > 0;
  const hasMissedLessons = bucket.missed_lessons > 0;
  const hasLate = bucket.late_days > 0;
  const priorityScore = (
    (hasAttention ? 1000 : 0) +
    (hasMissingReason ? 600 : 0) +
    (hasClarification ? 450 : 0) +
    (hasScheduleGap ? 320 : 0) +
    (hasLate ? 260 : 0) +
    (hasMissedLessons ? 220 : 0) +
    bucket.needs_attention * 40 +
    bucket.without_reason * 25 +
    bucket.needs_clarification * 20 +
    totalDataGaps * 12 +
    bucket.late_days * 15 +
    bucket.late_missed_lessons * 10 +
    bucket.missed_lessons * 8 +
    Math.round(bucket.late_minutes / 5) +
    bucket.absence_days_set.size
  );

  return {
    student_id: bucket.student_id,
    student_name: bucket.student_name,
    class_id: bucket.class_id,
    class_name: bucket.class_name,
    periods: bucket.periods,
    absence_days: bucket.absence_days_set.size,
    without_reason: bucket.without_reason,
    needs_attention: bucket.needs_attention,
    needs_clarification: bucket.needs_clarification,
    missed_lessons: bucket.missed_lessons,
    subjects: bucket.subjects,
    learning_days: bucket.learning_days,
    data_gaps: totalDataGaps,
    late_days: bucket.late_days,
    late_arrival_days: bucket.late_arrival_days,
    late_percent: bucket.late_percent,
    late_minutes: bucket.late_minutes,
    late_missed_lessons: bucket.late_missed_lessons,
    late_subjects: bucket.late_subjects,
    late_data_gaps: bucket.late_data_gaps,
    last_absence_id: bucket.last_absence_id,
    last_reason: bucket.last_reason,
    last_reason_code: bucket.last_reason_code,
    last_comment: bucket.last_comment,
    last_comment_short: truncateText(bucket.last_comment, 140),
    has_long_comment: String(bucket.last_comment || '').length > 140,
    last_starts_at: bucket.last_starts_at,
    last_ends_at: bucket.last_ends_at,
    last_period_date: formatCompactPeriodDate(bucket.last_starts_at, bucket.last_ends_at),
    last_period_time: formatCompactPeriodTime(bucket.last_starts_at, bucket.last_ends_at),
    last_period_label: formatCompactPeriodLabel(bucket.last_starts_at, bucket.last_ends_at),
    last_confirmation_status: bucket.last_confirmation_status,
    last_attention_status: bucket.last_attention_status,
    last_late_at: bucket.last_late_at,
    last_late_date: bucket.last_late_date,
    last_late_time: bucket.last_late_time,
    last_late_label: bucket.last_late_label,
    reason_codes: Array.from(bucket.reason_codes),
    has_attention: hasAttention,
    has_missing_reason: hasMissingReason,
    has_clarification: hasClarification,
    has_schedule_gap: hasScheduleGap,
    has_missed_lessons: hasMissedLessons,
    has_late: hasLate,
    has_signal: hasAttention || hasMissingReason || hasClarification || hasScheduleGap || hasMissedLessons || hasLate,
    priority_score: priorityScore,
    student_href: bucket.student_href || `/attendance?class=${encodeURIComponent(bucket.class_id)}&student=${encodeURIComponent(bucket.student_id)}&analyticsMonth=${encodeURIComponent(range?.month || '')}#learning-analytics`,
  };
}

function riskMatches(row, risk) {
  switch (risk) {
    case 'attention': return row.has_attention;
    case 'missing_reason': return row.has_missing_reason;
    case 'clarification': return row.has_clarification;
    case 'schedule_gap': return row.has_schedule_gap;
    case 'missed_lessons': return row.has_missed_lessons;
    case 'late': return row.has_late;
    default: return row.has_signal;
  }
}

function searchMatches(row, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [
    row.student_name,
    row.class_name,
    row.last_reason,
    row.last_comment,
    row.last_period_label,
    row.last_late_label,
  ].some((value) => String(value || '').toLowerCase().includes(q));
}

function compareRiskRows(a, b, sort) {
  switch (sort) {
    case 'latest':
      return compareDescText(a.last_starts_at, b.last_starts_at) || compareByName(a, b);
    case 'days':
      return b.absence_days - a.absence_days || compareDescText(a.last_starts_at, b.last_starts_at) || compareByName(a, b);
    case 'lessons':
      return b.missed_lessons - a.missed_lessons || b.data_gaps - a.data_gaps || compareByName(a, b);
    case 'late':
      return b.late_days - a.late_days || b.late_minutes - a.late_minutes || compareDescText(a.last_late_at, b.last_late_at) || compareByName(a, b);
    case 'late_minutes':
      return b.late_minutes - a.late_minutes || b.late_days - a.late_days || compareByName(a, b);
    case 'name':
      return compareByName(a, b);
    default:
      return b.priority_score - a.priority_score || compareDescText(a.last_starts_at, b.last_starts_at) || compareByName(a, b);
  }
}

function compareDescText(left, right) {
  return String(right || '').localeCompare(String(left || ''));
}

function compareByName(a, b) {
  return String(a.student_name || '').localeCompare(String(b.student_name || ''), 'ru');
}

function riskFilterOptions(selected) {
  return [
    ['all', 'Все сигналы'],
    ['attention', 'Внимание'],
    ['missing_reason', 'Без причины'],
    ['clarification', 'Уточнить'],
    ['schedule_gap', 'Без расписания'],
    ['missed_lessons', 'Пропущенные уроки'],
    ['late', 'Опоздания'],
  ].map(([id, name]) => ({ id, name, selected: id === selected }));
}

function riskSortOptions(selected) {
  return [
    ['priority', 'Приоритет'],
    ['latest', 'Последний период'],
    ['days', 'Дни'],
    ['lessons', 'Уроки'],
    ['late', 'Опоздания'],
    ['late_minutes', 'Минуты опозданий'],
    ['name', 'Имя'],
  ].map(([id, name]) => ({ id, name, selected: id === selected }));
}

function formatCompactPeriodLabel(startsAt, endsAt) {
  const date = formatCompactPeriodDate(startsAt, endsAt);
  const time = formatCompactPeriodTime(startsAt, endsAt);
  return [date, time].filter(Boolean).join(' ');
}

function formatCompactPeriodDate(startsAt, endsAt) {
  const start = dateTimeParts(startsAt);
  const end = dateTimeParts(endsAt);
  if (!start) return '';
  if (!end || start.date === end.date) return start.displayDate;
  return `${start.displayDate}-${end.displayDate}`;
}

function formatCompactPeriodTime(startsAt, endsAt) {
  const start = dateTimeParts(startsAt);
  const end = dateTimeParts(endsAt);
  if (!start) return '';
  if (!end) return `с ${start.time}`;
  return `${start.time}-${end.time}`;
}

function dateTimeParts(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour = '00', minute = '00'] = match;
  return {
    date: `${year}-${month}-${day}`,
    displayDate: `${day}.${month}.${year}`,
    time: `${hour}:${minute}`,
  };
}

function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
