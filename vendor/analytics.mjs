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
