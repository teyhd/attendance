import { normalizeScheduleLesson, parseDateTimeMs, formatDateLabel } from './schedule-analytics.mjs';

// Compare school-local SQL timestamps, independently of the Node process timezone.
export function buildAdultArrivalAnalytics({ range, people = [], presenceEvents = [], scheduleRows = [], publishedSchoolDays = [], now }) {
  const published = new Set(publishedSchoolDays);
  const lessons = new Map();
  const onlineDays = new Set();
  for (const row of scheduleRows) {
    const lesson = normalizeScheduleLesson(row);
    if (!lesson?.teacher_id) continue;
    const key = `${lesson.teacher_id}|${lesson.date}`;
    // A building arrival cannot establish lateness to a remote lesson.
    if (Number(row.is_online) === 1) {
      onlineDays.add(key);
      continue;
    }
    if (!lessons.has(key) || lesson.starts_ms < lessons.get(key).starts_ms) lessons.set(key, lesson);
  }
  const events = new Map();
  for (const event of presenceEvents) {
    if (event.cancelled_at || !['arrival', 'departure'].includes(event.event_type)) continue;
    if (!Number.isFinite(parseDateTimeMs(event.occurred_at)) || event.occurred_at > now) continue;
    const key = `${event.student_id}|${event.attendance_date}`;
    if (!events.has(key)) events.set(key, []);
    events.get(key).push(event);
  }
  const rows = people.map((person) => {
    const personId = String(person.person_id || person.student_id);
    const days = range.days.map((date) => {
      const dayEvents = (events.get(`${personId}|${date}`) || []).toSorted((a, b) => a.occurred_at.localeCompare(b.occurred_at) || Number(a.id) - Number(b.id));
      const arrival = dayEvents.find((event) => event.event_type === 'arrival');
      const last = dayEvents.at(-1);
      const lesson = lessons.get(`${personId}|${date}`);
      const future = date > now.slice(0, 10);
      const lateMinutes = arrival && lesson ? Math.max(0, Math.ceil((parseDateTimeMs(arrival.occurred_at) - lesson.starts_ms) / 60000)) : 0;
      const status = future ? 'future' : !published.has(date) ? 'no_schedule' : !lesson ? (onlineDays.has(`${personId}|${date}`) ? 'online_only' : 'no_lessons') : !arrival ? (lesson.starts_at > now ? 'expected' : 'no_arrival') : lateMinutes > 0 ? 'late' : 'on_time';
      const labels = { future: 'Ещё не наступил', no_schedule: 'Нет опубликованного расписания', no_lessons: 'Нет назначенных уроков', online_only: 'Только онлайн · приход не оценивается', expected: 'Ожидается приход', no_arrival: 'Нет отметки прихода', late: `Опоздание · ${lateMinutes} мин.`, on_time: 'Вовремя' };
      return {
        date, date_label: formatDateLabel(date),
        weekday: new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' }),
        arrival_time: arrival?.occurred_at.slice(11, 19) || '—',
        departure_time: last?.event_type === 'departure' ? last.occurred_at.slice(11, 19) : '—',
        lesson_time: lesson?.starts_at.slice(11, 19) || '—',
        lesson_label: lesson ? [lesson.subject_name, lesson.class_name].filter(Boolean).join(' · ') : '',
        late_minutes: status === 'late' ? lateMinutes : 0,
        status, status_label: labels[status], has_arrival: Boolean(arrival),
      };
    });
    return { person_id: personId, days, arrival_days: days.filter(d => d.has_arrival).length, late_days: days.filter(d => d.status === 'late').length, on_time_days: days.filter(d => d.status === 'on_time').length, no_arrival_days: days.filter(d => d.status === 'no_arrival').length, total_late_minutes: days.reduce((sum, d) => sum + d.late_minutes, 0) };
  });
  return { people: rows, arrival_days: rows.reduce((sum, p) => sum + p.arrival_days, 0), late_days: rows.reduce((sum, p) => sum + p.late_days, 0), late_people: rows.filter(p => p.late_days > 0).length, no_arrival_days: rows.reduce((sum, p) => sum + p.no_arrival_days, 0) };
}
