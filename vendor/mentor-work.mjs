import { isoWeekday, parseDateTimeMs } from './schedule-analytics.mjs';

const lunchMinutes = 30;
const moscowTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium',
});

export function schoolSqlNow(now = new Date()) {
  return moscowTime.format(now);
}

export function shiftDate(iso, days) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function minuteOfDay(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function grossMinutes(shift) {
  return minuteOfDay(shift[1]) - minuteOfDay(shift[0]);
}

export function workMinutes(shift) {
  return shift ? grossMinutes(shift) - lunchMinutes : 0;
}

export function minutesLabel(minutes) {
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (!hours && remainder) return `${remainder} мин`;
  return remainder ? `${hours} ч ${remainder} мин` : `${hours} ч`;
}

export function isWorkMentor(person) {
  return Number(person?.user_type) === 3;
}

export function readMentorScheduleSnapshot(snapshot) {
  if (!snapshot) return {};
  return typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
}

export async function getPublishedMentorWeeks(executor, range) {
  const firstMonday = shiftDate(range.start_date, 1 - isoWeekday(range.start_date));
  const [rows] = await executor.query(
    `SELECT DATE_FORMAT(week_start, '%Y-%m-%d') AS week_start, published_json
       FROM attendance.mentor_work_weeks
      WHERE week_start BETWEEN ? AND ? AND published_revision IS NOT NULL`,
    [firstMonday, range.end_date],
  );
  return new Map(rows.map((row) => [row.week_start, readMentorScheduleSnapshot(row.published_json)]));
}

export function publishedMentorDay(weeks, personId, date) {
  const weekday = isoWeekday(date);
  const monday = shiftDate(date, 1 - weekday);
  const week = weeks.get(monday);
  const shift = weekday <= 5 ? week?.[personId]?.[weekday - 1] : null;
  return { published: Boolean(week), shift: shift || null };
}

function measurePresence(events) {
  let open = null;
  let ambiguous = false;
  let incomplete = false;
  let actual = 0;
  for (const event of events) {
    if (event.event_type === 'arrival') {
      if (open) ambiguous = true;
      else open = event;
    } else {
      if (open && !ambiguous && event.ms > open.ms) actual += (event.ms - open.ms) / 60_000;
      else incomplete = true;
      open = null;
      ambiguous = false;
    }
  }
  const firstArrival = events.find((event) => event.event_type === 'arrival');
  const lastDeparture = events.findLast((event) => event.event_type === 'departure');
  return {
    actual: actual || null,
    arrival: firstArrival?.occurred_at.slice(11, 16) || '—',
    departure: lastDeparture?.occurred_at.slice(11, 16) || '—',
    open: Boolean(open),
    incomplete: incomplete || ambiguous,
  };
}

function varianceLabel(minutes) {
  const rounded = Math.round(Math.abs(minutes));
  return rounded ? `${minutes < 0 ? '−' : '+'}${minutesLabel(rounded)}` : '0 мин';
}

function measureDay(day, shift, published, events, hasConflict, now) {
  const today = now.slice(0, 10);
  const future = day.date > today;
  const ended = day.date < today || (shift && `${day.date} ${shift[1]}:00` <= now);
  const fact = measurePresence(events);
  const needsReview = !future && (hasConflict || fact.incomplete || (fact.open && day.date < today)
    || Boolean(ended && shift && !events.length));
  const comparable = Boolean(shift && ended && !needsReview && !fact.open && fact.actual !== null);
  const variance = comparable ? fact.actual - grossMinutes(shift) : null;
  let status = published ? 'Выходной' : 'График не опубликован';
  if (future) status = 'Ещё не наступил';
  else if (hasConflict) status = 'Конфликт отметок';
  else if (fact.incomplete) status = 'Неполные отметки';
  else if (fact.open) status = day.date < today ? 'Нет отметки ухода' : 'Ожидается уход';
  else if (fact.actual !== null) status = shift ? 'Отметки полные' : 'Присутствие вне графика';
  else if (shift) status = `${day.date} ${shift[0]}:00` <= now ? 'Нет отметки прихода' : 'Ожидается приход';
  return {
    ...day, planned: shift ? `${shift[0]}–${shift[1]}` : '—',
    planNet: shift ? minutesLabel(workMinutes(shift)) : '',
    actual: fact.actual === null ? '—' : minutesLabel(fact.actual),
    arrival: fact.arrival, departure: fact.departure,
    status, needsReview, comparable, variance: variance === null ? '—' : varianceLabel(variance),
    varianceTone: variance > 0 ? 'positive' : variance < 0 ? 'negative' : '',
    plannedMinutes: workMinutes(shift), actualMinutes: fact.actual,
    varianceMinutes: variance, elapsedShift: Boolean(shift && ended),
  };
}

export function buildMentorWorkReport({ roster, days, week, presenceEvents = [], conflicts = [], now }) {
  const published = week.published_revision !== null;
  const snapshot = published ? readMentorScheduleSnapshot(week.published_json) : {};
  const nowMs = parseDateTimeMs(now);
  const dayKeys = new Set(days.map((day) => day.date));
  const byPersonDay = new Map();
  const conflictsByPersonDay = new Set();
  for (const event of presenceEvents) {
    const id = String(event.student_id);
    const date = event.attendance_date;
    const ms = parseDateTimeMs(event.occurred_at);
    if (!roster.has(id) || !dayKeys.has(date) || event.cancelled_at
      || !['arrival', 'departure'].includes(event.event_type) || !Number.isFinite(ms) || ms > nowMs
      || event.occurred_at.slice(0, 10) !== date) continue;
    const key = `${id}|${date}`;
    if (!byPersonDay.has(key)) byPersonDay.set(key, []);
    byPersonDay.get(key).push({ ...event, ms });
  }
  for (const conflict of conflicts) {
    if (conflict.status !== 'open' || parseDateTimeMs(conflict.occurred_at) > nowMs) continue;
    conflictsByPersonDay.add(`${conflict.student_id}|${conflict.occurred_at.slice(0, 10)}`);
  }
  return Array.from(roster, ([id, name]) => {
    const shifts = snapshot[id] || [];
    const personDays = days.map((day) => {
      const key = `${id}|${day.date}`;
      const events = (byPersonDay.get(key) || []).sort((a, b) => a.ms - b.ms || Number(a.id) - Number(b.id));
      return measureDay(day, shifts[day.index], published, events, conflictsByPersonDay.has(key), now);
    });
    const comparableDays = personDays.filter((day) => day.comparable);
    const actualDays = personDays.filter((day) => day.actualMinutes !== null);
    const variance = comparableDays.reduce((sum, day) => sum + day.varianceMinutes, 0);
    return {
      id, name, days: personDays,
      plan: published ? minutesLabel(personDays.reduce((sum, day) => sum + day.plannedMinutes, 0)) : '—',
      fact: actualDays.length ? minutesLabel(actualDays.reduce((sum, day) => sum + day.actualMinutes, 0)) : '—',
      variance: comparableDays.length ? varianceLabel(variance) : '—',
      varianceTone: variance > 0 ? 'positive' : variance < 0 ? 'negative' : '',
      comparableDays: comparableDays.length,
      elapsedShifts: personDays.filter((day) => day.elapsedShift).length,
      incompleteDays: personDays.filter((day) => day.needsReview).length,
    };
  });
}
