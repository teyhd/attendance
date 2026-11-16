import { isSchoolWeekday, normalizeScheduleLesson, parseDateTimeMs, formatDateLabel } from './schedule-analytics.mjs';
import { isWorkMentor, publishedMentorDay } from './mentor-work.mjs';

// Compare school-local SQL timestamps, independently of the Node process timezone.
export function buildAdultArrivalAnalytics({
  range, people = [], presenceEvents = [], scheduleRows = [], publishedSchoolDays = [], mentorWeeks = new Map(), now,
}) {
  const published = new Set(publishedSchoolDays);
  const lessons = new Map();
  const onlineDays = new Set();
  for (const row of scheduleRows) {
    const lesson = normalizeScheduleLesson(row);
    if (!lesson?.teacher_id || !isSchoolWeekday(lesson.date)) continue;
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
    const isMentor = isWorkMentor(person);
    const days = range.days.map((date) => {
      const key = `${personId}|${date}`;
      const dayEvents = (events.get(key) || []).toSorted((a, b) => a.occurred_at.localeCompare(b.occurred_at) || Number(a.id) - Number(b.id));
      const arrival = dayEvents.find((event) => event.event_type === 'arrival');
      const last = dayEvents.at(-1);
      const mentorDay = isMentor ? publishedMentorDay(mentorWeeks, personId, date) : null;
      const shift = mentorDay?.shift;
      const lesson = isMentor ? null : lessons.get(key);
      const start = shift ? `${date} ${shift[0]}:00` : lesson?.starts_at;
      const future = date > now.slice(0, 10);
      const lateMinutes = arrival && start ? Math.max(0, Math.ceil((parseDateTimeMs(arrival.occurred_at) - parseDateTimeMs(start)) / 60000)) : 0;
      let status;
      if (!isSchoolWeekday(date)) status = 'weekend';
      else if (future) status = 'future';
      else if (isMentor && !mentorDay.published) status = 'no_mentor_schedule';
      else if (isMentor && !shift) status = 'no_shift';
      else if (!isMentor && !published.has(date)) status = 'no_schedule';
      else if (!start) status = onlineDays.has(key) ? 'online_only' : 'no_lessons';
      else if (!arrival) status = start > now ? 'expected' : 'no_arrival';
      else status = lateMinutes > 0 ? 'late' : 'on_time';
      const labels = {
        weekend: 'Выходной', future: 'Ещё не наступил', no_schedule: 'Нет опубликованного расписания',
        no_mentor_schedule: 'График наставников не опубликован', no_shift: 'Смена не запланирована',
        no_lessons: 'Нет назначенных уроков', online_only: 'Только онлайн · приход не оценивается',
        expected: 'Ожидается приход', no_arrival: 'Нет отметки прихода',
        late: `Опоздание · ${lateMinutes} мин.`, on_time: 'Вовремя',
      };
      return {
        date, date_label: formatDateLabel(date),
        weekday: new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' }),
        arrival_time: arrival?.occurred_at.slice(11, 19) || '—',
        departure_time: last?.event_type === 'departure' ? last.occurred_at.slice(11, 19) : '—',
        lesson_time: lesson?.starts_at.slice(11, 19) || '—',
        lesson_label: lesson ? [lesson.subject_name, lesson.class_name].filter(Boolean).join(' · ') : '',
        schedule_basis: isMentor ? 'mentor_shift' : 'lesson',
        shift_time: shift ? `${shift[0]}–${shift[1]}` : '—',
        late_minutes: status === 'late' ? lateMinutes : 0,
        status, status_label: labels[status], has_arrival: Boolean(arrival),
      };
    });
    return { person_id: personId, is_mentor: isMentor, days, arrival_days: days.filter(d => d.has_arrival).length, late_days: days.filter(d => d.status === 'late').length, on_time_days: days.filter(d => d.status === 'on_time').length, no_arrival_days: days.filter(d => d.status === 'no_arrival').length, total_late_minutes: days.reduce((sum, d) => sum + d.late_minutes, 0) };
  });
  return { people: rows, arrival_days: rows.reduce((sum, p) => sum + p.arrival_days, 0), late_days: rows.reduce((sum, p) => sum + p.late_days, 0), late_people: rows.filter(p => p.late_days > 0).length, no_arrival_days: rows.reduce((sum, p) => sum + p.no_arrival_days, 0) };
}
