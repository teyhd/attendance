import { mlog } from './vendor/logs.mjs';

process.on('uncaughtException', (err) => {
  mlog('Глобальный косяк приложения!!! ', err.stack);
});

import 'dotenv/config';

import * as db from './vendor/db.mjs';
import { isWithoutReasonCode } from './vendor/absence-reasons.mjs';
import { requireApiAuth, requirePageAuth, requirePermission, setupAuthRoutes } from './vendor/auth.mjs';

import express from 'express';
import exphbs from 'express-handlebars';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

let i_count = 1;
const PORT = process.env.PORT || 789;
const app = express();
const hbs = exphbs.create({
  defaultLayout: 'main',
  extname: 'hbs',
  helpers: {
    OK: function () {
      i_count = 1;
    },
    inc() {
      return i_count++;
    },
    reset() {
      i_count = 1;
      return '';
    },
    substr(str, start, len) {
      str = (str ?? '').toString();
      const s = Number(start) || 0;
      const l = (len == null) ? undefined : Number(len);
      return str.substring(s, l ? s + l : undefined);
    },
    findById(arr, id) {
      if (!Array.isArray(arr)) return null;
      const target = arr.find((x) => String(x?.id) === String(id));
      return target || null;
    },
    eq(a, b) { return String(a) === String(b); },
    ne(a, b) { return String(a) !== String(b); },
    gt(a, b) { return Number(a) > Number(b); },
    lt(a, b) { return Number(a) < Number(b); },
    and() {
      const args = Array.from(arguments).slice(0, -1);
      return args.every(Boolean);
    },
    or() {
      const args = Array.from(arguments).slice(0, -1);
      return args.some(Boolean);
    },
    json(ctx) {
      try {
        return JSON.stringify(ctx)
          .replace(/</g, '\\u003c')
          .replace(/>/g, '\\u003e')
          .replace(/&/g, '\\u0026')
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029');
      } catch {
        return 'null';
      }
    },
    displayDate(value) {
      return formatDisplayDateOnly(value);
    },
    roleLabel(user) {
      return roleLabel(user);
    },
    urlEncode(value) {
      return encodeURIComponent(String(value ?? ''));
    },
    I_C: function () {
      let anso = '';
      for (let i = 0; i < i_count; i++) {
        anso += 'I';
      }
      i_count++;
      return anso;
    },
    PLS: function (a) {
      return a + 10;
    },
    if_eq: function (a, b, opts) {
      if (a == b) {
        return opts.fn(this);
      }
      return opts.inverse(this);
    },
    if_more: function (a, b, opts) {
      if (a >= b) {
        return opts.fn(this);
      }
      return opts.inverse(this);
    },
    for: function (from, to, incr, block) {
      let accum = '';
      for (let i = from; i < to; i += incr) {
        accum += block.fn(i);
      }
      return accum;
    },
  },
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const appDir = __dirname;
const attendanceFilterIds = new Set(['all', 'current', 'future', 'missing', 'attention']);

app.engine('hbs', hbs.engine);
app.set('view engine', 'hbs');

const viewsPath = path.join(appDir, 'views');
const publicPath = path.join(appDir, 'public');

app.set('views', viewsPath);
mlog(publicPath);
app.use(express.static(publicPath));

app.use(cookieParser());
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.locals.enableUxRocket = shouldEnableUxRocket(req);
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
setupAuthRoutes(app);

await db.ensureAttendanceSchema();

app.get('/', (req, res) => {
  res.redirect('/attendance');
});

app.get('/attendance', requirePageAuth, asyncHandler(async (req, res) => {
  const baseClasses = await db.getClasses();
  const mentorClassIds = await db.getMentorClassIds(req.authUser?.id);
  const classes = orderClassesByPreference(baseClasses, mentorClassIds);
  const selectedClass = resolveSelectedClass(classes, req.query.class);
  const selectedDate = normalizeDateInput(req.query.date) || formatDateInput(new Date());
  const schoolDay = await db.getSchoolDayBounds(selectedDate);
  const activeFilter = normalizeAttendanceFilter(req.query.filter);
  const q = String(req.query.q || '').trim();
  const allClassChildren = selectedClass ? await db.getStudentsByClass(selectedClass) : [];
  const searchedChildren = filterStudents(allClassChildren, q);
  const requestedStudent = req.query.student;
  const summary = selectedClass ? await db.getAttendanceSummary({ classId: selectedClass, date: selectedDate }) : null;
  const classDayAbsences = selectedClass
    ? await db.listAbsencePeriods({ classId: selectedClass, from: selectedDate, to: selectedDate, limit: 500 })
    : [];
  const nowSql = formatSqlDateTime(new Date());
  const classActiveAbsences = selectedClass
    ? await db.listAbsencePeriods({ classId: selectedClass, currentOrFuture: true, limit: 500 })
    : [];
  const classCurrentAbsences = classActiveAbsences.filter((absence) => isCurrentAbsence(absence, nowSql));
  const classFutureAbsences = classActiveAbsences.filter((absence) => isFutureAbsence(absence, nowSql));
  const classStats = selectedClass ? await db.getClassAbsenceStats(selectedClass, { days: 30 }) : new Map();
  const activeAbsenceByStudent = new Map(
    classCurrentAbsences.map((absence) => [String(absence.student_id), absence]),
  );
  const futureAbsenceByStudent = new Map(
    classFutureAbsences.map((absence) => [String(absence.student_id), absence]),
  );
  const dayAbsenceByStudent = new Map(
    classDayAbsences.map((absence) => [String(absence.student_id), absence]),
  );

  const filteredChildren = searchedChildren
    .map((child) => {
      const currentAbsence = activeAbsenceByStudent.get(String(child.id));
      const futureAbsence = futureAbsenceByStudent.get(String(child.id));
      const dayAbsence = dayAbsenceByStudent.get(String(child.id));
      const stats = classStats.get(String(child.id)) || {};
      return {
        ...child,
        hasAbsence: Boolean(currentAbsence),
        hasCurrentAbsence: Boolean(currentAbsence),
        hasFutureAbsence: Boolean(futureAbsence),
        currentAbsence,
        futureAbsence,
        dayAbsence,
        stats,
        isFrequent: Boolean(stats.frequent_absence),
        hasMissingReason: isWithoutReasonCode(currentAbsence?.reason_code)
          || isWithoutReasonCode(futureAbsence?.reason_code)
          || isWithoutReasonCode(dayAbsence?.reason_code),
        needsAttention: currentAbsence?.attention_status === 'needs_attention'
          || futureAbsence?.attention_status === 'needs_attention'
          || dayAbsence?.attention_status === 'needs_attention',
      };
    })
    .filter((child) => {
      if (activeFilter === 'current') return child.hasCurrentAbsence;
      if (activeFilter === 'future') return child.hasFutureAbsence;
      if (activeFilter === 'missing') return child.hasMissingReason;
      if (activeFilter === 'attention') return child.needsAttention;
      return true;
    });

  const selectedChild = allClassChildren.find((c) => String(c.id) === String(requestedStudent))
    || filteredChildren[0]
    || allClassChildren[0]
    || null;
  const selectedStudentId = selectedChild?.id || '';
  const canManage = Boolean(req.authUser?.permissions?.mark_absence);
  const children = filteredChildren.map((child) => ({
    ...child,
    isActive: selectedStudentId && String(selectedStudentId) === String(child.id),
    href: attendanceUrl({
      classId: selectedClass,
      studentId: child.id,
      date: selectedDate,
      filter: activeFilter,
      q,
    }),
  }));

  const childAbsences = selectedStudentId
    ? await db.listAbsencePeriods({ studentId: selectedStudentId, limit: 100 })
    : [];
  const currentAbsences = selectedStudentId
    ? await db.listAbsencePeriods({ studentId: selectedStudentId, currentOrFuture: true, limit: 50 })
    : [];
  const activeNowAbsences = currentAbsences.filter((absence) => isCurrentAbsence(absence, nowSql));
  const futureAbsences = currentAbsences.filter((absence) => isFutureAbsence(absence, nowSql));
  const studentContext = selectedStudentId
    ? await db.getStudentContext(selectedStudentId, { days: 30 })
    : null;
  const reasons = await db.getAbsenceReasons();

  res.render('attendance', {
    title: 'Посещаемость',
    currentUser: req.authUser,
    activePage: 'attendance',
    classes,
    mentorClassIds,
    children,
    selectedChild,
    selectedStudentId,
    childAbsences,
    currentAbsences,
    activeNowAbsences,
    futureAbsences,
    classCurrentAbsences,
    classFutureAbsences,
    classDayAbsences,
    summary,
    studentContext,
    selectedClass,
    selectedDate,
    schoolDay,
    activeFilter,
    q,
    reasons,
    defaultFrom: defaultDateTimeForDate(selectedDate, schoolDay),
    filters: buildFilters(activeFilter, {
      classId: selectedClass,
      date: selectedDate,
      q,
    }),
    success: req.query.success,
    error: req.query.error,
    canManage,
  });
}));

app.get('/attendance/analytics', requirePageAuth, asyncHandler(async (req, res) => {
  const mentorClassIds = await db.getMentorClassIds(req.authUser?.id);
  const classId = req.query.class || mentorClassIds[0] || undefined;
  const analytics = await db.getMonthlyAttendanceAnalytics({
    month: req.query.month,
    classId,
    risk: req.query.risk,
    reason: req.query.reason,
    q: req.query.q,
    sort: req.query.sort,
  });
  const canManage = Boolean(req.authUser?.permissions?.mark_absence);

  res.render('analytics', {
    title: 'Аналитика посещаемости',
    currentUser: req.authUser,
    activePage: 'analytics',
    analytics,
    classOptions: orderClassesByPreference(analytics.available_classes, mentorClassIds),
    kpiCards: buildAnalyticsKpiCards(analytics),
    canManage,
  });
}));

app.get('/attendance/presence', requirePageAuth, requirePermission('manage_presence'), asyncHandler(async (req, res) => {
  const selectedDate = formatDateInput(new Date());
  const board = await db.getPresenceBoard({ date: selectedDate });

  res.render('presence', {
    title: 'Приход / уход',
    currentUser: req.authUser,
    activePage: 'presence',
    board,
  });
}));

app.get('/attendance/:childId/new', requirePageAuth, asyncHandler(async (req, res) => {
  const { childId } = req.params;
  const selectedClass = req.query.class;
  const child = await db.getStudentById(childId);
  if (!child) return res.status(404).send('Ученик не найден');

  const redirectClass = selectedClass || child.classId;
  return res.redirect(attendanceUrl({ classId: redirectClass, studentId: child.id }));
}));

app.post('/attendance', requirePageAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  try {
    const absence = await db.createAbsencePeriod(absenceInputFromBody(req.body, req.authUser));
    res.redirect(attendanceUrl({
      classId: absence.class_id,
      studentId: absence.student_id,
      date: dateOnlyFromDateTime(absence.starts_at) || req.body.date,
      filter: req.body.filter,
      q: req.body.q,
      analyticsMonth: req.body.analyticsMonth,
      success: 'created',
    }));
  } catch (err) {
    res.redirect(attendanceUrl({
      classId: req.body.classId,
      studentId: req.body.childId,
      date: req.body.date,
      filter: req.body.filter,
      q: req.body.q,
      analyticsMonth: req.body.analyticsMonth,
      error: userErrorMessage(err),
    }));
  }
}));

app.post('/attendance/:absenceId/update', requirePageAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  try {
    const absence = await db.updateAbsencePeriod(req.params.absenceId, absenceInputFromBody(req.body, req.authUser));
    if (!absence) {
      return res.redirect(attendanceUrl({
        classId: req.body.classId,
        studentId: req.body.childId,
        date: req.body.date,
        filter: req.body.filter,
        q: req.body.q,
        analyticsMonth: req.body.analyticsMonth,
        error: 'Отметка не найдена',
      }));
    }
    return res.redirect(attendanceUrl({
      classId: absence.class_id,
      studentId: absence.student_id,
      date: dateOnlyFromDateTime(absence.starts_at) || req.body.date,
      filter: req.body.filter,
      q: req.body.q,
      analyticsMonth: req.body.analyticsMonth,
      success: 'updated',
    }));
  } catch (err) {
    return res.redirect(attendanceUrl({
      classId: req.body.classId,
      studentId: req.body.childId,
      date: req.body.date,
      filter: req.body.filter,
      q: req.body.q,
      analyticsMonth: req.body.analyticsMonth,
      error: userErrorMessage(err),
    }));
  }
}));

app.post('/attendance/:absenceId/delete', requirePageAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  const deleted = await db.softDeleteAbsencePeriod(req.params.absenceId, req.authUser?.id);
  res.redirect(attendanceUrl({
    classId: req.body.classId,
    studentId: req.body.childId,
    date: req.body.date,
    filter: req.body.filter,
    q: req.body.q,
    analyticsMonth: req.body.analyticsMonth,
    success: deleted ? 'deleted' : '',
    error: deleted ? '' : 'Отметка не найдена',
  }));
}));

app.post('/attendance/:absenceId/resolve', requirePageAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  const absence = await db.resolveAbsenceAttention(req.params.absenceId, req.authUser?.id);
  res.redirect(attendanceUrl({
    classId: req.body.classId || absence?.class_id,
    studentId: req.body.childId || absence?.student_id,
    date: req.body.date,
    filter: req.body.filter,
    q: req.body.q,
    analyticsMonth: req.body.analyticsMonth,
    success: absence ? 'resolved' : '',
    error: absence ? '' : 'Отметка не найдена',
  }));
}));

// Read model for Diary and analytics: absence periods with filters.
app.get('/api/attendance/absences', requireApiAuth, asyncHandler(async (req, res) => {
  const periods = await db.listAbsencePeriods({
    from: req.query.from,
    to: req.query.to,
    classId: req.query.classId,
    studentId: req.query.studentId,
    limit: req.query.limit,
  });
  res.json({ items: periods.map(toPublicAbsence) });
}));

// Read model for Diary and analytics: class counters for one school day.
app.get('/api/attendance/summary', requireApiAuth, asyncHandler(async (req, res) => {
  if (!req.query.classId) {
    return res.status(400).json({ error: 'classId_required' });
  }
  const summary = await db.getAttendanceSummary({
    classId: req.query.classId,
    date: req.query.date,
  });
  return res.json(summary);
}));

// Read model for mentors: compact recent context for one student.
app.get('/api/attendance/students/:id/context', requireApiAuth, asyncHandler(async (req, res) => {
  const context = await db.getStudentContext(req.params.id, { days: req.query.days || 30 });
  return res.json(context);
}));

app.get('/api/attendance/students/:id/analytics', requireApiAuth, asyncHandler(async (req, res) => {
  const analytics = await db.getStudentMonthlyAnalytics(req.params.id, { month: req.query.month });
  return res.json({
    ...analytics,
    can_manage: Boolean(req.authUser?.permissions?.mark_absence),
  });
}));

// Monthly read model for reports and integrations. It is read-only and does not write diary marks.
app.get('/api/attendance/analytics/monthly', requireApiAuth, asyncHandler(async (req, res) => {
  const analytics = await db.getMonthlyAttendanceAnalytics({
    month: req.query.month,
    classId: req.query.classId || req.query.class,
    risk: req.query.risk,
    reason: req.query.reason,
    q: req.query.q,
    sort: req.query.sort,
  });
  return res.json(analytics);
}));

app.post('/api/attendance/absences', requireApiAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  try {
    const absence = await db.createAbsencePeriod(absenceInputFromBody(req.body, req.authUser));
    res.status(201).json(toPublicAbsence(absence));
  } catch (err) {
    sendApiError(res, err);
  }
}));

app.post('/api/attendance/presence/toggle', requireApiAuth, requirePermission('manage_presence'), asyncHandler(async (req, res) => {
  try {
    const result = await db.togglePresenceEvent(presenceInputFromBody(req.body, req.authUser));
    res.status(result.duplicate ? 200 : 201).json({
      event: toPublicPresenceEvent(result.event),
      state: result.state,
      duplicate: Boolean(result.duplicate),
    });
  } catch (err) {
    sendApiError(res, err);
  }
}));

app.post('/api/attendance/presence/events/:id/cancel', requireApiAuth, requirePermission('manage_presence'), asyncHandler(async (req, res) => {
  try {
    const result = await db.cancelPresenceEvent(req.params.id, req.authUser?.id);
    if (!result) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({
      cancelled: true,
      event: toPublicPresenceEvent(result.event),
      state: result.state,
    });
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.patch('/api/attendance/absences/:id', requireApiAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  try {
    const absence = await db.updateAbsencePeriod(req.params.id, absenceInputFromBody(req.body, req.authUser));
    if (!absence) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json(toPublicAbsence(absence));
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.delete('/api/attendance/absences/:id', requireApiAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  const deleted = await db.softDeleteAbsencePeriod(req.params.id, req.authUser?.id);
  if (!deleted) {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.json({ deleted: true });
}));

app.post('/api/attendance/absences/:id/resolve', requireApiAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  const absence = await db.resolveAbsenceAttention(req.params.id, req.authUser?.id);
  if (!absence) {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.json(toPublicAbsence(absence));
}));

app.use((err, req, res, next) => {
  mlog('Ошибка обработки запроса', err?.stack || err);
  if (res.headersSent) return next(err);
  if (req.path?.startsWith('/api/')) {
    if (err?.status && err.status < 500) {
      return res.status(err.status).json({ error: 'validation_error', message: err.message });
    }
    return res.status(500).json({ error: 'internal_error' });
  }
  return res.status(500).send('Не удалось загрузить данные посещаемости');
});

app.listen(PORT, () => {
  mlog(`Приложение запущено на порту ${PORT}`);
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function shouldEnableUxRocket(req) {
  if (process.env.UXROCKET_ENABLED !== '1') return false;
  const host = String(req.hostname || req.get('host') || '').toLowerCase();
  return !host.includes('localhost') && !host.includes('127.0.0.1') && !host.includes('::1');
}

function roleLabel(user) {
  const role = String(user?.role || '').trim();
  if (role === 'admin') return 'Админ';
  if (role === 'tutor') return 'Тьютор';
  if (role === 'mentor') return 'Наставник';
  if (role === 'teacher') return 'Педагог · только чтение';
  return user?.permissions?.mark_absence ? 'Сотрудник · запись' : 'Сотрудник · чтение';
}

function filterStudents(students, q) {
  if (!q) return students;
  const needle = q.toLocaleLowerCase('ru');
  return students.filter((student) => String(student.name || '').toLocaleLowerCase('ru').includes(needle));
}

function absenceInputFromBody(body, user) {
  return {
    studentId: body.studentId ?? body.student_id ?? body.childId,
    classId: body.classId ?? body.class_id,
    startsAt: body.startsAt ?? body.starts_at ?? body.from,
    endsAt: body.endsAt ?? body.ends_at ?? body.to,
    reasonCode: body.reasonCode ?? body.reason_code ?? body.reason,
    comment: body.comment,
    source: body.source,
    confirmationStatus: body.confirmationStatus ?? body.confirmation_status,
    attentionStatus: body.attentionStatus ?? body.attention_status,
    actorId: user?.id || null,
  };
}

function presenceInputFromBody(body, user) {
  return {
    studentId: body.studentId ?? body.student_id,
    classId: body.classId ?? body.class_id,
    idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
    actorId: user?.id || null,
  };
}

function toPublicAbsence(absence) {
  return {
    id: absence.id,
    student_id: Number(absence.student_id),
    class_id: Number(absence.class_id),
    starts_at: absence.starts_at,
    ends_at: absence.ends_at,
    reason_code: absence.reason_code,
    reason_name: absence.reason_name,
    is_without_reason: Boolean(absence.is_without_reason),
    is_excused: absence.is_excused,
    requires_attention: absence.requires_attention,
    default_confirmation_status: absence.default_confirmation_status,
    source: absence.source,
    confirmation_status: absence.confirmation_status,
    confirmation_label: absence.confirmation_label,
    attention_status: absence.attention_status,
    attention_label: absence.attention_label,
    needs_attention: absence.needs_attention,
    resolved_at: absence.resolved_at || null,
    resolved_by: absence.resolved_by ? Number(absence.resolved_by) : null,
    comment: absence.comment,
    created_by: absence.created_by ? Number(absence.created_by) : null,
    created_at: absence.created_at,
    updated_at: absence.updated_at,
  };
}

function toPublicPresenceEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    student_id: Number(event.student_id),
    class_id: Number(event.class_id),
    student_name: event.student_name || '',
    class_name: event.class_name || '',
    event_type: event.event_type,
    event_label: event.event_label,
    occurred_at: event.occurred_at,
    occurred_time: event.occurred_time,
    attendance_date: event.attendance_date,
    actor_id: event.actor_id ? Number(event.actor_id) : null,
    source: event.source,
    cancelled_at: event.cancelled_at || null,
    cancelled_by: event.cancelled_by ? Number(event.cancelled_by) : null,
    created_at: event.created_at,
    updated_at: event.updated_at,
  };
}

function buildAnalyticsKpiCards(analytics) {
  const kpi = analytics.kpi || {};
  const learning = analytics.learning || {};
  const lateness = analytics.lateness || {};
  const withoutReason = Number(kpi.without_reason || 0);
  const needsAttention = Number(kpi.needs_attention || 0);
  const hasAbsenceData = Boolean(analytics.has_data);
  const hasQualityTarget = hasAbsenceData && Boolean(analytics.quality?.has_issues);
  const target = (condition, id, actionLabel) => (condition
    ? { href: `#${id}`, target_id: id, action_label: actionLabel }
    : {});

  return [
    {
      label: 'Ученики с отсутствиями',
      value: `${Number(kpi.students_with_absences || 0)} / ${Number(kpi.students_total || 0)}`,
      hint: 'за выбранный месяц',
      border_class: 'border-sky-500',
      ...target(hasAbsenceData, 'risk-students', 'Смотреть учеников'),
    },
    {
      label: 'Пропущено уроков',
      value: Number(learning.missed_lessons_total || 0),
      hint: 'по расписанию',
      border_class: 'border-indigo-500',
      ...target(Boolean(learning.has_data), 'learning-analytics', 'Смотреть уроки'),
    },
    {
      label: 'Опоздания',
      value: Number(lateness.late_days_total || 0),
      hint: 'ученик-дней',
      border_class: Number(lateness.late_days_total || 0) ? 'border-amber-500' : 'border-emerald-500',
      ...target(Boolean(lateness.has_activity), 'lateness-analytics', 'Смотреть опоздания'),
    },
    {
      label: 'Дней отсутствия',
      value: Number(kpi.absence_days || 0),
      hint: 'ученик-день',
      border_class: 'border-indigo-500',
      ...target(hasAbsenceData, 'absence-calendar', 'Смотреть календарь'),
    },
    {
      label: 'Без причины',
      value: withoutReason,
      hint: 'записей с причиной "Без причины"',
      border_class: withoutReason ? 'border-amber-500' : 'border-emerald-500',
      ...target(hasQualityTarget, 'data-quality', 'Разобрать'),
    },
    {
      label: 'Открытые вопросы',
      value: needsAttention,
      hint: needsAttention ? 'отметки, которые нужно разобрать' : 'нет отметок, требующих действия',
      border_class: needsAttention ? 'border-red-500' : 'border-emerald-500',
      ...target(hasAbsenceData, 'risk-students', 'Открыть список'),
    },
  ];
}

function attendanceUrl({ classId, studentId, date, filter, q, analyticsMonth, success, error }) {
  const params = new URLSearchParams();
  if (classId) params.set('class', classId);
  if (studentId) params.set('student', studentId);
  if (date) params.set('date', date);
  if (filter) params.set('filter', normalizeAttendanceFilter(filter));
  if (q) params.set('q', q);
  if (analyticsMonth) params.set('analyticsMonth', analyticsMonth);
  if (success) params.set('success', success);
  if (error) params.set('error', error);
  const query = params.toString();
  return query ? `/attendance?${query}` : '/attendance';
}

function userErrorMessage(err) {
  if (err?.status && err.status < 500) return err.message;
  mlog('Ошибка сохранения посещаемости', err?.stack || err);
  return 'Не удалось сохранить отметку';
}

function sendApiError(res, err) {
  if (err?.status && err.status < 500) {
    return res.status(err.status).json({ error: 'validation_error', message: err.message });
  }
  mlog('Ошибка API посещаемости', err?.stack || err);
  return res.status(500).json({ error: 'internal_error' });
}

function formatDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultDateTimeForDate(value, schoolDay = null) {
  const date = normalizeDateInput(value) || formatDateInput(new Date());
  const today = formatDateInput(new Date());
  const dayStart = schoolDay?.start_input || `${date}T09:00`;
  const dayEnd = schoolDay?.end_input || `${date}T19:00`;
  if (date !== today) return dayStart;

  const now = formatDateTimeLocal(new Date());
  if (now < dayStart || now >= dayEnd) return dayStart;
  return now;
}

function formatDateInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDisplayDateOnly(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : raw;
}

function formatSqlDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dateOnlyFromDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function isCurrentAbsence(absence, nowSql = formatSqlDateTime(new Date())) {
  if (!absence?.starts_at) return false;
  const startsAt = String(absence.starts_at);
  const endsAt = String(absence.ends_at || '9999-12-31 23:59:59');
  return startsAt <= nowSql && endsAt >= nowSql;
}

function isFutureAbsence(absence, nowSql = formatSqlDateTime(new Date())) {
  if (!absence?.starts_at) return false;
  return String(absence.starts_at) > nowSql;
}

function normalizeDateInput(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const [, y, mo, d] = match;
  const candidate = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    candidate.getUTCFullYear() !== Number(y) ||
    candidate.getUTCMonth() + 1 !== Number(mo) ||
    candidate.getUTCDate() !== Number(d)
  ) {
    return '';
  }
  return raw;
}

function resolveSelectedClass(classes, requestedClass) {
  if (!classes.length) return '';
  const requested = String(requestedClass || '').trim();
  const found = classes.find((item) => String(item.id) === requested);
  return found ? String(found.id) : String(classes[0].id);
}

function orderClassesByPreference(classes, preferredClassIds = []) {
  if (!Array.isArray(classes) || !classes.length) return [];
  const preferred = new Set((preferredClassIds || []).map((id) => String(id)));
  if (!preferred.size) return classes;

  return classes
    .map((item, index) => ({
      ...item,
      isMentorClass: preferred.has(String(item.id)),
      originalIndex: index,
    }))
    .sort((a, b) => Number(b.isMentorClass) - Number(a.isMentorClass) || a.originalIndex - b.originalIndex)
    .map(({ originalIndex, ...item }) => item);
}

function normalizeAttendanceFilter(value) {
  const candidate = String(value || 'all').trim();
  return attendanceFilterIds.has(candidate) ? candidate : 'all';
}

function buildFilters(activeFilter, context = {}) {
  const filters = [
    { id: 'all', name: 'Все' },
    { id: 'current', name: 'Сейчас' },
    { id: 'future', name: 'Будущие' },
    { id: 'missing', name: 'Без причины' },
    { id: 'attention', name: 'Требуют внимания' },
  ];
  return filters.map((filter) => ({
    ...filter,
    active: activeFilter === filter.id,
    href: attendanceUrl({
      classId: context.classId,
      date: context.date,
      filter: filter.id,
      q: context.q,
      analyticsMonth: context.analyticsMonth,
    }),
  }));
}
