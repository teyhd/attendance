const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 90;
const MAX_OCCURRENCES = 60;

export function expandWeeklyAbsences(input, repeatUntil, repeatWeekdays) {
  const start = String(input.startsAt || '').slice(0, 10);
  const end = String(input.endsAt || '').slice(0, 10);
  const first = parseDate(start);
  const last = parseDate(repeatUntil);
  if (!first || !last || last < first || (last - first) / DAY_MS > MAX_DAYS) {
    fail('Выберите дату окончания повторов в пределах 90 дней от начала');
  }
  if (input.endsAt && end !== start) {
    fail('Для повторов начало и окончание должны быть в один день');
  }
  const values = Array.isArray(repeatWeekdays) ? repeatWeekdays : [repeatWeekdays];
  const weekdays = new Set(values.map(String));
  if (!weekdays.size || [...weekdays].some((day) => !/^[1-7]$/.test(day))) {
    fail('Выберите хотя бы один день недели');
  }
  const startsTime = String(input.startsAt || '').slice(10);
  const endsTime = input.endsAt ? String(input.endsAt).slice(10) : '';
  if (!/^T\d{2}:\d{2}$/.test(startsTime) || (input.endsAt && !/^T\d{2}:\d{2}$/.test(endsTime))) {
    fail('Укажите время начала и окончания');
  }
  const items = [];
  for (let day = first; day <= last; day = new Date(day.getTime() + DAY_MS)) {
    const weekday = String(day.getUTCDay() || 7);
    if (!weekdays.has(weekday)) continue;
    const date = day.toISOString().slice(0, 10);
    items.push({ ...input, startsAt: `${date}${startsTime}`, endsAt: endsTime ? `${date}${endsTime}` : '' });
  }
  if (!items.length) fail('В выбранном периоде нет отмеченных дней недели');
  if (items.length > MAX_OCCURRENCES) fail('Можно создать не более 60 отметок за раз');
  return items;
}

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}
