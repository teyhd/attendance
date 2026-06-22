const MONTH_NAMES = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

export function normalizeAnalyticsMonth(value, now = new Date()) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) {
      return raw;
    }
  }

  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}

export function buildMonthRange(month) {
  const normalized = normalizeAnalyticsMonth(month);
  const [yearText, monthText] = normalized.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const startDate = `${normalized}-01`;
  const endDate = `${normalized}-${pad2(lastDay)}`;

  return {
    month: normalized,
    month_label: `${MONTH_NAMES[monthIndex]} ${year}`,
    start_date: startDate,
    end_date: endDate,
    start_at: `${startDate} 00:00:00`,
    end_at: `${endDate} 23:59:59`,
    days_count: lastDay,
    days: Array.from({ length: lastDay }, (_, index) => `${normalized}-${pad2(index + 1)}`),
  };
}

export function expandDateRangeWithinMonth(startsAt, endsAt, range) {
  const startDate = dateOnly(startsAt);
  const endDate = dateOnly(endsAt) || startDate;
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

export function dateOnly(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

export function percentOf(value, total) {
  if (!total) return 0;
  return Math.round((Number(value || 0) / Number(total)) * 100);
}

export function countActualPresenceDays(events = []) {
  return presenceDayKeys(events).size;
}

export function expectedPresenceDates(range, { publishedSchoolDays = [], activeWeekdays = [1, 2, 3, 4, 5] } = {}) {
  const rangeDays = Array.isArray(range?.days) ? range.days : [];
  if (!rangeDays.length) return [];

  const rangeDaySet = new Set(rangeDays);
  const published = [...new Set((publishedSchoolDays || []).map(dateOnly).filter((day) => rangeDaySet.has(day)))];
  if (published.length) return published.sort();

  const weekdaySet = new Set((activeWeekdays || [])
    .map(Number)
    .filter((day) => day >= 1 && day <= 7));
  const fallbackWeekdays = weekdaySet.size ? weekdaySet : new Set([1, 2, 3, 4, 5]);
  return rangeDays.filter((day) => fallbackWeekdays.has(isoWeekday(day)));
}

export function buildClassPresenceSummary({
  range,
  studentsTotal = 0,
  arrivals = [],
  lateness = {},
  todayAbsences = {},
  publishedSchoolDays = [],
  activeWeekdays = [1, 2, 3, 4, 5],
  absenceDays = 0,
  needsAttention = 0,
  needsClarification = 0,
  withoutReason = 0,
  riskStudentsTotal = 0,
} = {}) {
  const presenceDays = countActualPresenceDays(arrivals);
  const schoolDays = expectedPresenceDates(range, { publishedSchoolDays, activeWeekdays });
  const expectedPresenceDays = Math.max(0, Number(studentsTotal || 0)) * schoolDays.length;
  const lateDays = Number(lateness?.late_days_total || 0);
  const coveredArrivalDays = Number.isFinite(Number(lateness?.coverage?.covered_arrival_days))
    ? Number(lateness.coverage.covered_arrival_days)
    : Math.max(0, presenceDays - Number(lateness?.data_gaps_total || 0));

  return {
    attendance_percent: percentOf(presenceDays, expectedPresenceDays),
    presence_days: presenceDays,
    expected_presence_days: expectedPresenceDays,
    expected_school_days: schoolDays.length,
    absent_today: Number(todayAbsences?.totals?.absent_students_today || 0),
    late_days: lateDays,
    on_time_days: Math.max(0, coveredArrivalDays - lateDays),
    covered_arrival_days: coveredArrivalDays,
    risk_students_total: Number(riskStudentsTotal || 0),
    absence_days: Number(absenceDays || 0),
    needs_attention: Number(needsAttention || 0),
    needs_clarification: Number(needsClarification || 0),
    without_reason: Number(withoutReason || 0),
  };
}

export function hoursWithinRange(startsAt, endsAt, range) {
  const startMs = parseDateTimeMs(startsAt);
  const endMs = parseDateTimeMs(endsAt || endOfStartDay(startsAt));
  const rangeStartMs = parseDateTimeMs(range?.start_at);
  const rangeEndMs = parseDateTimeMs(range?.end_at);
  if (![startMs, endMs, rangeStartMs, rangeEndMs].every(Number.isFinite)) return 0;

  const from = Math.max(startMs, rangeStartMs);
  const to = Math.min(endMs, rangeEndMs);
  if (to <= from) return 0;
  return (to - from) / 3_600_000;
}

export function compareClassNames(left, right) {
  const a = classNameParts(left);
  const b = classNameParts(right);
  if (a.hasNumber !== b.hasNumber) return a.hasNumber ? -1 : 1;
  if (a.number !== b.number) return a.number - b.number;
  return (
    a.suffix.localeCompare(b.suffix, 'ru', { numeric: true, sensitivity: 'base' }) ||
    a.text.localeCompare(b.text, 'ru', { numeric: true, sensitivity: 'base' })
  );
}

function classNameParts(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)(?:[-\s]*(.*))?$/u);
  return {
    text,
    hasNumber: Boolean(match),
    number: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
    suffix: match?.[2] || '',
  };
}

function parseDateTimeMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function presenceDayKeys(events = []) {
  const keys = new Set();
  for (const event of events || []) {
    if (event?.cancelled_at) continue;
    if (event?.event_type && event.event_type !== 'arrival') continue;
    const studentId = String(event?.student_id || event?.studentId || '').trim();
    const day = dateOnly(event?.attendance_date || event?.arrival_at || event?.occurred_at);
    if (studentId && day) keys.add(`${studentId}|${day}`);
  }
  return keys;
}

function isoWeekday(dateText) {
  const [year, month, day] = String(dateText || '').split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function endOfStartDay(value) {
  const date = dateOnly(value);
  return date ? `${date} 23:59:59` : '';
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
