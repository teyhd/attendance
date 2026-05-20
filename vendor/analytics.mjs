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

export function hoursWithinRange(startsAt, endsAt, range) {
  if (!endsAt) return 0;
  const startMs = parseDateTimeMs(startsAt);
  const endMs = parseDateTimeMs(endsAt);
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
