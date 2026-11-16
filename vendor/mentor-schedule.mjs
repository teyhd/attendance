import { canManageMentorSchedule, canViewMentorSchedule, getAuthConfig, renderRequestError, requireApiAuth, requirePageAuth } from './auth.mjs';
import { buildMentorWorkReport, minuteOfDay, minutesLabel, readMentorScheduleSnapshot, schoolSqlNow, shiftDate, workMinutes } from './mentor-work.mjs';

export { workMinutes } from './mentor-work.mjs';
export { canManageMentorSchedule, canViewMentorSchedule } from './auth.mjs';

const schedulePath = '/attendance/mentor-schedule';
const weekdayNames = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница'];
const weekdayShortNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт'];
const maxMentors = 500;
const schoolDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' });
const russianDate = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric',
});

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

export function mentorScheduleWeek(input, now = new Date()) {
  const today = schoolDate.format(now);
  const date = input === undefined ? today : input;
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) fail('Неверная дата недели.');
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail('Неверная дата недели.');
  const monday = shiftDate(date, -((parsed.getUTCDay() + 6) % 7));
  return { today, monday };
}

export function normalizeMentorScheduleRows(rows, roster) {
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) fail('Передайте график наставников.');
  const entries = Object.entries(rows);
  if (entries.length > maxMentors) fail('Слишком много строк графика.');
  const snapshot = {};
  for (const [id, week] of entries) {
    if (!roster.has(id)) fail('Состав наставников изменился. Обновите страницу.');
    if (!Array.isArray(week) || week.length !== 5) fail('График должен содержать пять рабочих дней.');
    const days = week.map((shift, index) => {
      if (shift === null) return null;
      const label = `${roster.get(id)}, ${weekdayNames[index].toLowerCase()}`;
      if (!Array.isArray(shift) || shift.length !== 2
        || !Number.isFinite(minuteOfDay(shift[0])) || !Number.isFinite(minuteOfDay(shift[1]))) {
        fail(`${label}. Укажите и приход, и уход.`);
      }
      if (workMinutes(shift) <= 0) fail(`${label}. Смена должна длиться больше 30 минут.`);
      return shift;
    });
    if (days.some(Boolean)) snapshot[id] = days;
  }
  return snapshot;
}

async function getRoster(executor) {
  const [rows] = await executor.query(
    `SELECT CAST(u.id AS CHAR) AS id, u.name
       FROM sso.users u
       JOIN (
         SELECT usr_id, MAX(role_id) AS role_id FROM sso.rights WHERE srv_id = ? GROUP BY usr_id
       ) r ON r.usr_id = u.id
      WHERE u.status = 1 AND u.type = 3 AND u.id > 0 AND r.role_id IN (3, 5)
      ORDER BY u.name, u.id`,
    [getAuthConfig().serviceID],
  );
  return new Map(rows.map(({ id, name }) => [id, name]));
}

async function getWeek(executor, monday, lock = false) {
  const [rows] = await executor.query(
    `SELECT draft_json, published_json, revision, published_revision
       FROM attendance.mentor_work_weeks WHERE week_start = ? ${lock ? 'FOR UPDATE' : ''}`,
    [monday],
  );
  return rows[0] || { revision: 0, published_revision: null };
}

function scheduleStatus(week) {
  if (week.published_revision === week.revision) return 'Опубликован';
  if (week.published_revision !== null) return 'Есть неопубликованные изменения';
  return week.revision ? 'Черновик' : 'Не опубликован';
}

async function saveWeek(pool, monday, body, userId) {
  if (!Number.isSafeInteger(body?.revision) || body.revision < 0 || typeof body?.publish !== 'boolean') {
    fail('Неверная версия графика. Обновите страницу.');
  }
  if (!/^[1-9]\d*$/.test(String(userId))) fail('Войдите под своей учётной записью.', 403);
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await db.query(
      'INSERT INTO attendance.mentor_work_weeks (week_start) VALUES (?) ON DUPLICATE KEY UPDATE week_start = VALUES(week_start)',
      [monday],
    );
    const previous = await getWeek(db, monday, true);
    if (previous.revision !== body.revision) fail('График уже изменили. Обновите страницу и проверьте новую версию.', 409);
    const priorDraft = readMentorScheduleSnapshot(previous.draft_json);
    const roster = await getRoster(db);
    const snapshot = JSON.stringify(normalizeMentorScheduleRows(body.rows, roster));
    const changed = snapshot !== JSON.stringify(priorDraft);
    const revision = previous.revision + Number(changed);
    if (body.publish && previous.published_revision !== revision) {
      await db.query(
        `UPDATE attendance.mentor_work_weeks
            SET draft_json = ?, published_json = ?, revision = ?, published_revision = ?,
                updated_by = ?, published_by = ?, updated_at = NOW(), published_at = NOW()
          WHERE week_start = ?`,
        [snapshot, snapshot, revision, revision, userId, userId, monday],
      );
    } else if (changed) {
      await db.query(
        `UPDATE attendance.mentor_work_weeks SET draft_json = ?, revision = ?, updated_by = ?, updated_at = NOW()
          WHERE week_start = ?`,
        [snapshot, revision, userId, monday],
      );
    }
    await db.commit();
    return { revision, status: scheduleStatus({
      revision, published_revision: body.publish ? revision : previous.published_revision,
    }) };
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

function makeDays(monday, today) {
  const activeDay = Math.min(4, Math.max(0, weekdayNames.findIndex((_, index) => shiftDate(monday, index) === today)));
  return weekdayNames.map((name, index) => {
    const date = shiftDate(monday, index);
    return {
      index, name, shortName: weekdayShortNames[index], date, today: date === today,
      dateLabel: `${date.slice(8)}.${date.slice(5, 7)}`,
      active: index === activeDay,
    };
  });
}

function rowView(id, name, days, snapshot) {
  const shifts = snapshot[id] || [];
  const minutes = shifts.reduce((sum, shift) => sum + workMinutes(shift), 0);
  return {
    id, name, total: minutesLabel(minutes), hasShifts: shifts.some(Boolean),
    days: days.map((day) => {
      const shift = shifts[day.index];
      return { ...day, personName: name, start: shift?.[0], end: shift?.[1], duration: minutesLabel(workMinutes(shift)) };
    }),
  };
}

export function registerMentorScheduleRoutes(app, pool, getMentorWorkPresence) {
  app.get(schedulePath, requirePageAuth, async (req, res) => {
    if (!canViewMentorSchedule(req.authUser)) {
      return renderRequestError(req, res, { status: 403, message: 'График доступен наставникам и сотрудникам с правом его редактировать.' });
    }
    const now = new Date();
    const { monday, today } = mentorScheduleWeek(req.query.week, now);
    const canManage = canManageMentorSchedule(req.authUser);
    const editing = canManage && req.query.view !== 'me';
    const roster = await getRoster(pool);
    const hasPersonalSchedule = roster.has(String(req.authUser.id));
    if (!editing && !hasPersonalSchedule) {
      if (canManage) return res.redirect(`${schedulePath}?week=${monday}`);
      return renderRequestError(req, res, { status: 403, message: 'Вашей учётной записи пока нет в списке наставников. Обратитесь к администратору школы.' });
    }
    const week = await getWeek(pool, monday);
    const days = makeDays(monday, today);
    const snapshot = readMentorScheduleSnapshot(editing ? week.draft_json : week.published_json);
    const reportRoster = editing ? roster : new Map([[String(req.authUser.id), req.authUser.name]]);
    const presence = await getMentorWorkPresence({ start_date: monday, end_date: days[4].date }, [...reportRoster.keys()]);
    const workReport = buildMentorWorkReport({ roster: reportRoster, days, week, ...presence, now: schoolSqlNow(now) });
    const personal = rowView(String(req.authUser.id), req.authUser.name, days, snapshot);
    const suffix = editing ? '' : '&view=me';
    const url = (date) => `${schedulePath}?week=${date}${suffix}`;
    const dateLabel = `${days[0].dateLabel} — ${russianDate.format(new Date(`${days[4].date}T12:00:00Z`))}`;
    res.set('Cache-Control', 'private, no-store');
    return res.render('mentor-schedule', {
      title: editing ? 'График наставников' : 'Мой график',
      currentUser: req.authUser,
      activePage: 'mentor-schedule',
      wideLayout: editing, canManage, hasPersonalSchedule, editing, personal, days, dateLabel, monday,
      previous: url(shiftDate(monday, -7)), next: url(shiftDate(monday, 7)), current: url(mentorScheduleWeek(undefined).monday),
      switchView: `${schedulePath}?week=${monday}${editing ? '&view=me' : ''}`,
      roster: editing ? Array.from(roster, ([id, name]) => rowView(id, name, days, snapshot)) : [],
      workReport,
      published: week.published_revision !== null, status: scheduleStatus(week), revision: week.revision,
    });
  });

  app.put('/api/attendance/mentor-schedule/:week', requireApiAuth, async (req, res) => {
    if (!canManageMentorSchedule(req.authUser)) return res.status(403).json({ message: 'Нет доступа к изменению графика' });
    const { monday } = mentorScheduleWeek(req.params.week);
    if (monday !== req.params.week) fail('Укажите понедельник выбранной недели.');
    return res.json(await saveWeek(pool, monday, req.body, req.authUser.id));
  });
}
