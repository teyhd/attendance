import { buildMonthRange } from './analytics.mjs';
import { buildAnalyticsRange } from './attendance-analytics-contract.mjs';

export const STUDENT_EXPORT_MODE_LABELS = {
  missed: 'Подтверждённые пропуски',
  review: 'Пропуски и неполные отметки',
  all: 'Все уроки',
};

export function parseStudentExportOptions({ month, from, to, format, mode = 'missed' }) {
  if (format !== 'pdf' && format !== 'csv') throw new TypeError('Выберите PDF или CSV.');
  if (typeof mode !== 'string' || !Object.hasOwn(STUDENT_EXPORT_MODE_LABELS, mode)) {
    throw new TypeError('Выберите, какие уроки включить.');
  }
  if (month !== undefined) {
    if (from !== undefined || to !== undefined || typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new TypeError('Укажите месяц в формате ГГГГ-ММ.');
    }
    const dates = buildMonthRange(month);
    from = dates.start_date;
    to = dates.end_date;
  }
  if (typeof from !== 'string' || typeof to !== 'string') throw new TypeError('Укажите начало и конец периода.');
  return { range: buildAnalyticsRange(from, to), format, mode };
}

export function buildStudentExportReport({ student, lessons, missingScheduleDates, unplacedAbsenceDays }, range, mode) {
  const rows = lessons
    .filter((row) => mode === 'all' || row.confirmedAbsenceMinutes > 0 ||
      (mode === 'review' && (row.noMarkMinutes > 0 || row.conflictMinutes > 0 || row.estimatedLateMinutes > 0)))
    .map((row) => {
      const { confirmedAbsenceMinutes, noMarkMinutes, lateMinutes, conflictMinutes, attendedMinutes } = row;
      const statuses = [];
      if (confirmedAbsenceMinutes > 0) statuses.push(confirmedAbsenceMinutes >= row.scheduledMinutes ? 'Пропуск' : 'Частичный пропуск');
      if (lateMinutes > 0) statuses.push('Опоздание');
      if (row.estimatedLateMinutes > 0) statuses.push('Опоздание по сообщению · оценка');
      if (noMarkMinutes > 0) statuses.push('Нет подтверждения');
      if (conflictMinutes > 0) statuses.push('Расхождение отметок');
      if (!statuses.length) statuses.push(attendedMinutes > 0 ? 'Присутствие' : 'Нет подтверждения');
      const reasons = row.reasonMinutes.filter(({ code }) => code !== 'no_mark' && code !== 'late').map(({ name }) => name);
      if (row.estimatedLateMinutes > 0) {
        reasons.push(`По времени сообщения о приходе на урок · около ${row.estimatedLateMinutes} мин`);
      }
      return {
        date: row.date,
        start: row.lesson.starts_at.slice(11, 16),
        end: row.lesson.ends_at.slice(11, 16),
        subject: row.subjectName || 'Урок',
        status: statuses.join(' · '),
        confirmedMinutes: confirmedAbsenceMinutes,
        unknownMinutes: noMarkMinutes,
        lateMinutes,
        reason: [...new Set(reasons)].join(', '),
      };
    });
  return {
    student, from: range.from, to: range.to, mode, rows, missingScheduleDates, unplacedAbsenceDays,
    unconfirmedLessons: lessons.filter((row) => row.noMarkMinutes > 0 || row.conflictMinutes > 0).length,
  };
}

export function renderStudentAttendanceCsv(report) {
  const { student, from, to, mode, rows, missingScheduleDates, unplacedAbsenceDays, unconfirmedLessons } = report;
  const head = ['Ученик', 'Класс', 'Период с', 'Период по', 'Отчёт', 'Дата', 'Начало', 'Конец', 'Предмет',
    'Статус', 'Пропуск по отметке, мин', 'Без подтверждения, мин', 'Опоздание, мин', 'Причина'];
  const prefix = [student.name, student.className, from, to, STUDENT_EXPORT_MODE_LABELS[mode]];
  const body = rows.map(({ date, start, end, subject, status, confirmedMinutes, unknownMinutes, lateMinutes, reason }) =>
    [...prefix, date, start, end, subject, status, confirmedMinutes, unknownMinutes, lateMinutes, reason]);
  if (!body.length) {
    body.push([...prefix, '', '', '', '', emptyStudentExportMessage(mode), '', '', '', '']);
  }
  if (mode === 'missed' && unconfirmedLessons) {
    body.push([...prefix, '', '', '', '', `Уроки без подтверждения или с расхождениями: ${unconfirmedLessons}`, '', '', '', '']);
  }
  const absenceDays = new Set(unplacedAbsenceDays);
  const qualityDays = [...new Set([...missingScheduleDates, ...unplacedAbsenceDays])].sort();
  for (const date of qualityDays) {
    const note = absenceDays.has(date) ? 'Есть отметка об отсутствии, нет уроков для сопоставления' : 'Нет данных расписания';
    body.push([...prefix, date, '', '', '', note, '', '', '', '']);
  }
  return '\uFEFF' + [head, ...body].map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export function emptyStudentExportMessage(mode) {
  if (mode === 'missed') return 'Подтверждённых пропусков по урокам за период нет.';
  if (mode === 'review') return 'Пропусков и неполных отметок по урокам за период нет.';
  return 'Нет данных по урокам за период.';
}

function csvCell(value) {
  if (typeof value === 'number') return String(value).replace('.', ',');
  const text = String(value ?? '');
  const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/u.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}
