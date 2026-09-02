import { mlog } from './vendor/logs.mjs';

process.on('uncaughtException', (err) => {
  mlog('Глобальный косяк приложения!!! ', err.stack);
});

import 'dotenv/config';

import * as db from './vendor/db.mjs';
import { isWithoutReasonCode } from './vendor/absence-reasons.mjs';
import { buildAttendanceActions } from './vendor/attendance-ui.mjs';
import { canManagePresenceClass } from './vendor/presence.mjs';
import {
  getAuthUserFromRequest,
  requireApiAuth,
  requireOwnAttendanceAuth,
  requirePageAuth,
  requirePermission,
  setupAuthRoutes,
} from './vendor/auth.mjs';
import { sanitizeStudentMonthlyAnalytics } from './vendor/student-analytics-view.mjs';
import { verifyInternalServiceRequest } from './vendor/internal-service-auth.mjs';

import express from 'express';
import exphbs from 'express-handlebars';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

let i_count = 1;
const PORT = process.env.PORT || 789;
const app = express();
const LEGACY_EXCUSED_REASON_CODE = 'excused';
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
const attendanceFilterIds = new Set(['all', 'current', 'missing']);

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
app.use(express.json({
  limit: '1mb',
  verify(req, res, buffer) {
    req.rawJsonBody = buffer.toString('utf8');
  },
}));
setupAuthRoutes(app);

await db.ensureAttendanceSchema();

app.post('/internal/v1/feedback-snapshots', requireProgressService, asyncHandler(async (req, res) => {
  try {
    const items = await db.getFeedbackAttendanceSnapshots(req.body || {});
    return res.json({ items });
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.post('/internal/v2/attendance/analytics/query', requireAnalyticsService, asyncHandler(async (req, res) => {
  try {
    return res.json(await db.getAttendanceAnalyticsQuery(req.body || {}));
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.post('/internal/v1/attendance/lesson-facts', requireDiaryService, asyncHandler(async (req, res) => {
  try {
    const result = await db.upsertLessonAttendanceFacts({
      sourceService: req.internalService,
      items: req.body?.items,
    });
    return res.json(result);
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.post('/internal/v1/attendance/lessons/resolve', requireDiaryService, asyncHandler(async (req, res) => {
  try {
    return res.json(await db.resolveLessonAttendanceRequests(req.body || {}));
  } catch (err) {
    return sendApiError(res, err);
  }
}));

const AUDIENCE_CHILDREN = 'children';
const AUDIENCE_ADULTS = 'adults';

app.get('/', (req, res) => {
  const user = getAuthUserFromRequest(req);
  if (user?.permissions?.view_own_attendance) {
    return res.redirect('/attendance/me');
  }
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
  const q = '';
  const allClassChildren = selectedClass ? await db.getStudentsByClass(selectedClass) : [];
  const searchedChildren = allClassChildren;
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
    }),
  }));
  const attendanceSummaryFilters = buildAttendanceSummaryFilters(summary, {
    activeFilter,
    classId: selectedClass,
    date: selectedDate,
  });
  const attendanceFilterTable = buildAttendanceFilterTable({
    activeFilter,
    classId: selectedClass,
    date: selectedDate,
    absences: classDayAbsences,
  });

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
  const reasons = (await db.getAbsenceReasons())
    .filter((reason) => reason.code !== LEGACY_EXCUSED_REASON_CODE);

  res.render('attendance', {
    title: 'Пропуски',
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
    attendanceSummaryFilters,
    attendanceFilterTable,
    studentContext,
    selectedClass,
    selectedDate,
    schoolDay,
    activeFilter,
    q,
    reasons,
    defaultFrom: defaultDateTimeForDate(selectedDate, schoolDay),
    attendanceActions: buildAttendanceActions(canManage),
    success: req.query.success,
    error: req.query.error,
    canManage,
  });
}));

app.get('/attendance/me', requireOwnAttendanceAuth, asyncHandler(async (req, res) => {
  const analytics = sanitizeStudentMonthlyAnalytics(
    await db.getStudentMonthlyAnalytics(req.authUser.id, { month: req.query.month, metricVersion: 2 }),
  );

  res.render('student-analytics', {
    title: 'Моя посещаемость',
    currentUser: req.authUser,
    activePage: 'student-attendance',
    analytics,
  });
}));

app.get('/attendance/analytics', requirePageAuth, asyncHandler(async (req, res) => {
  const audience = normalizePageAudience(req.query.audience, req.authUser);
  const canManage = Boolean(req.authUser?.permissions?.mark_absence);
  const canManagePresence = Boolean(req.authUser?.permissions?.manage_presence);
  const audienceTabs = buildAudienceTabs('/attendance/analytics', audience, req.query, req.authUser);

  if (audience === AUDIENCE_ADULTS) {
    const analytics = await db.getAdultAttendanceAnalytics({
      month: req.query.month,
      departmentId: req.query.department,
      metricVersion: 2,
    });

    return res.render('analytics', {
      title: 'Аналитика посещаемости',
      currentUser: req.authUser,
      activePage: 'analytics',
      audience,
      audienceTabs,
      analytics,
      classOptions: [],
      departmentOptions: analytics.available_departments,
      kpiCards: buildAdultAnalyticsKpiCards(analytics),
      canManage,
      canManagePresence,
    });
  }

  const mentorClassIds = await db.getMentorClassIds(req.authUser?.id);
  const availableClasses = await db.getClasses();
  const classId = req.query.class || mentorClassIds[0] || availableClasses[0]?.id || undefined;
  const analytics = await db.getMonthlyAttendanceAnalytics({
    month: req.query.month,
    classId,
    metricVersion: 2,
  });
  analytics.journal_school_day = await db.getSchoolDayBounds(formatDateInput(new Date()));

  res.render('analytics', {
    title: 'Аналитика посещаемости',
    currentUser: req.authUser,
    activePage: 'analytics',
    audience,
    audienceTabs,
    analytics,
    classOptions: orderClassesByPreference(analytics.available_classes, mentorClassIds),
    departmentOptions: [],
    kpiCards: buildAnalyticsKpiCards(analytics),
    canManage,
    canManagePresence,
  });
}));

app.get('/attendance/presence', requirePageAuth, requirePermission('manage_presence'), asyncHandler(async (req, res) => {
  const audience = normalizePageAudience(req.query.audience, req.authUser);
  const selectedDate = formatDateInput(new Date());
  const classIds = await getPresenceClassScope(req.authUser, audience);
  const board = await db.getPresenceBoard({ date: selectedDate, audience, classIds });

  res.render('presence', {
    title: 'Ручной ввод',
    currentUser: req.authUser,
    activePage: 'presence',
    audience,
    audienceTabs: buildAudienceTabs('/attendance/presence', audience, req.query, req.authUser),
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
      analyticsMonth: req.body.analyticsMonth,
      success: 'created',
    }));
  } catch (err) {
    res.redirect(attendanceUrl({
      classId: req.body.classId,
      studentId: req.body.childId,
      date: req.body.date,
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
        analyticsMonth: req.body.analyticsMonth,
        error: 'Отметка не найдена',
      }));
    }
    return res.redirect(attendanceUrl({
      classId: absence.class_id,
      studentId: absence.student_id,
      date: dateOnlyFromDateTime(absence.starts_at) || req.body.date,
      analyticsMonth: req.body.analyticsMonth,
      success: 'updated',
    }));
  } catch (err) {
    return res.redirect(attendanceUrl({
      classId: req.body.classId,
      studentId: req.body.childId,
      date: req.body.date,
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

app.get('/api/attendance/presence/events', requireApiAuth, asyncHandler(async (req, res) => {
  const events = await db.listPresenceEvents({
    from: req.query.from,
    to: req.query.to,
    classId: req.query.classId,
    studentId: req.query.studentId,
    limit: req.query.limit,
  });
  res.json({ items: events.map(toPublicPresenceEvent) });
}));

app.get('/api/attendance/conflicts', requireApiAuth, requirePermission('manage_presence'), asyncHandler(async (req, res) => {
  const audience = normalizeApiAudience(req.query.audience);
  if (!canUseAudience(req.authUser, audience)) return res.status(403).json({ error: 'forbidden' });
  const classIds = await getPresenceClassScope(req.authUser, audience);
  const conflicts = await db.listAttendanceConflicts({
    audience,
    classIds,
    studentId: req.query.studentId,
    from: req.query.from,
    to: req.query.to,
    status: req.query.status,
    limit: req.query.limit,
  });
  return res.json({ items: conflicts.map(toPublicAttendanceConflict) });
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
    can_manage_presence: await canManageStudentPresence(req.authUser, analytics.student?.class_id),
  });
}));

app.get('/api/v2/attendance/students/:id/analytics', requireApiAuth, asyncHandler(async (req, res) => {
  const analytics = await db.getStudentMonthlyAnalytics(req.params.id, { month: req.query.month, metricVersion: 2 });
  return res.json({
    ...analytics,
    can_manage: Boolean(req.authUser?.permissions?.mark_absence),
    can_manage_presence: await canManageStudentPresence(req.authUser, analytics.student?.class_id),
  });
}));

app.get('/api/v2/attendance/people/:id/analytics', requireApiAuth, asyncHandler(async (req, res) => {
  const personType = req.query.personType === 'employee' ? 'employee' : 'student';
  const audience = personType === 'employee' ? AUDIENCE_ADULTS : AUDIENCE_CHILDREN;
  if (!canUseAudience(req.authUser, audience)) return res.status(403).json({ error: 'forbidden' });
  try {
    const payload = await db.getAttendanceAnalyticsQuery({
      period: { from: req.query.from, to: req.query.to },
      items: [{
        key: 'person',
        personId: req.params.id,
        personType,
        subjectId: req.query.subjectId,
      }],
    });
    return res.json(payload.items[0]);
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.get('/api/attendance/me/analytics', requireOwnAttendanceAuth, asyncHandler(async (req, res) => {
  const analytics = await db.getStudentMonthlyAnalytics(req.authUser.id, { month: req.query.month });
  return res.json(sanitizeStudentMonthlyAnalytics(analytics));
}));

// Monthly read model for reports and integrations. It is read-only and does not write diary marks.
app.get('/api/attendance/analytics/monthly', requireApiAuth, asyncHandler(async (req, res) => {
  const audience = normalizeApiAudience(req.query.audience);
  if (audience === AUDIENCE_ADULTS) {
    if (!canUseAudience(req.authUser, audience)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const analytics = await db.getAdultAttendanceAnalytics({
      month: req.query.month,
      departmentId: req.query.departmentId || req.query.department,
    });
    return res.json(analytics);
  }

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

app.get('/api/v2/attendance/analytics/monthly', requireApiAuth, asyncHandler(async (req, res) => {
  const audience = normalizeApiAudience(req.query.audience);
  if (!canUseAudience(req.authUser, audience)) return res.status(403).json({ error: 'forbidden' });
  if (audience === AUDIENCE_ADULTS) {
    return res.json(await db.getAdultAttendanceAnalytics({
      month: req.query.month,
      departmentId: req.query.departmentId || req.query.department,
      metricVersion: 2,
    }));
  }
  return res.json(await db.getMonthlyAttendanceAnalytics({
    month: req.query.month,
    classId: req.query.classId || req.query.class,
    risk: req.query.risk,
    reason: req.query.reason,
    q: req.query.q,
    sort: req.query.sort,
    metricVersion: 2,
  }));
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
    const input = presenceInputFromBody(req.body, req.authUser);
    if (!canUseAudience(req.authUser, input.audience)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const classIds = await getPresenceClassScope(req.authUser, input.audience);
    if (!canManagePresenceClass(classIds, input.classId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const result = await db.togglePresenceEvent(input);
    res.status(result.duplicate ? 200 : 201).json({
      event: toPublicPresenceEvent(result.event),
      state: result.state,
      conflicts: (result.conflicts || []).map(toPublicAttendanceConflict),
      duplicate: Boolean(result.duplicate),
    });
  } catch (err) {
    sendApiError(res, err);
  }
}));

app.post('/api/attendance/presence/late', requireApiAuth, requirePermission('mark_absence'), asyncHandler(async (req, res) => {
  try {
    const result = await db.createManualLatePresenceEvent({
      studentId: req.body.studentId ?? req.body.student_id,
      classId: req.body.classId ?? req.body.class_id,
      occurredAt: req.body.occurredAt ?? req.body.occurred_at,
      idempotencyKey: req.body.idempotencyKey ?? req.body.idempotency_key,
      actorId: req.authUser?.id || null,
    });
    return res.status(result.duplicate ? 200 : 201).json({
      event: toPublicPresenceEvent(result.event),
      state: result.state,
      conflicts: (result.conflicts || []).map(toPublicAttendanceConflict),
      duplicate: Boolean(result.duplicate),
    });
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.post('/api/attendance/presence/events/:id/cancel', requireApiAuth, requirePermission('manage_presence'), asyncHandler(async (req, res) => {
  try {
    const audience = normalizeApiAudience(req.body?.audience);
    if (!canUseAudience(req.authUser, audience)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const classIds = await getPresenceClassScope(req.authUser, audience);
    const result = await db.cancelPresenceEvent(req.params.id, req.authUser?.id, {
      audience,
      classIds,
      allowAutomaticLatest: isAdmin(req.authUser),
    });
    if (!result) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({
      cancelled: true,
      event: toPublicPresenceEvent(result.event),
      state: result.state,
      conflicts: (result.conflicts || []).map(toPublicAttendanceConflict),
    });
  } catch (err) {
    return sendApiError(res, err);
  }
}));

app.post('/api/attendance/conflicts/:id/resolve', requireApiAuth, requirePermission('manage_presence'), asyncHandler(async (req, res) => {
  try {
    const audience = normalizeApiAudience(req.body?.audience);
    if (!canUseAudience(req.authUser, audience)) return res.status(403).json({ error: 'forbidden' });
    const classIds = await getPresenceClassScope(req.authUser, audience);
    const conflict = await db.resolveAttendanceConflict(
      req.params.id,
      req.body?.resolution,
      req.authUser?.id,
      { audience, classIds },
    );
    if (!conflict) return res.status(404).json({ error: 'not_found' });
    return res.json({ conflict: toPublicAttendanceConflict(conflict) });
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
  if (req.path?.startsWith('/api/') || req.path?.startsWith('/internal/')) {
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

function requireProgressService(req, res, next) {
  return verifyAttendanceService(req, res, next, ['progress']);
}

function requireAnalyticsService(req, res, next) {
  return verifyAttendanceService(req, res, next, ['progress', 'diary']);
}

function requireDiaryService(req, res, next) {
  return verifyAttendanceService(req, res, next, ['diary']);
}

function verifyAttendanceService(req, res, next, allowedServices) {
  const serviceName = String(req.get('x-service-name') || '').trim().toLowerCase();
  const verification = verifyInternalServiceRequest({
    serviceName,
    timestamp: req.get('x-service-timestamp'),
    signature: req.get('x-service-signature'),
    rawBody: req.rawJsonBody,
    serviceKey: internalServiceKey(serviceName),
    allowedServices,
  });
  if (!verification.ok) {
    return res.status(verification.status).json({ error: verification.error });
  }
  req.internalService = serviceName;
  return next();
}

function internalServiceKey(serviceName) {
  if (serviceName === 'progress') {
    return process.env.ATTENDANCE_PROGRESS_SERVICE_KEY || process.env.ATTENDANCE_SERVICE_KEY;
  }
  if (serviceName === 'diary') {
    return process.env.ATTENDANCE_DIARY_SERVICE_KEY || process.env.ATTENDANCE_SERVICE_KEY;
  }
  return '';
}

function shouldEnableUxRocket(req) {
  if (process.env.UXROCKET_ENABLED !== '1') return false;
  const host = String(req.hostname || req.get('host') || '').toLowerCase();
  return !host.includes('localhost') && !host.includes('127.0.0.1') && !host.includes('::1');
}

function roleLabel(user) {
  const role = String(user?.role || '').trim();
  if (role === 'student') return 'Ученик';
  if (role === 'admin') return 'Админ';
  if (role === 'tutor') return 'Тьютор';
  if (role === 'mentor') return 'Наставник';
  if (role === 'teacher') return 'Педагог · только чтение';
  return user?.permissions?.mark_absence ? 'Сотрудник · запись' : 'Сотрудник · чтение';
}

function normalizePageAudience(value, user) {
  const audience = normalizeApiAudience(value);
  return canUseAudience(user, audience) ? audience : AUDIENCE_CHILDREN;
}

function normalizeApiAudience(value) {
  return String(value || '').trim() === AUDIENCE_ADULTS ? AUDIENCE_ADULTS : AUDIENCE_CHILDREN;
}

function canUseAudience(user, audience) {
  if (audience === AUDIENCE_ADULTS) {
    return Boolean(user?.permissions?.view_adult_attendance);
  }
  return Boolean(user?.permissions?.use_attendance);
}

async function getPresenceClassScope(user, audience) {
  if (isAdmin(user)) return null;
  if (String(user?.role || '') !== 'mentor' || audience !== AUDIENCE_CHILDREN) return [];
  return db.getMentorClassIds(user?.id);
}

async function canManageStudentPresence(user, classId) {
  if (!user?.permissions?.manage_presence) return false;
  const classIds = await getPresenceClassScope(user, AUDIENCE_CHILDREN);
  return canManagePresenceClass(classIds, classId);
}

function isAdmin(user) {
  return Number(user?.rawRoleId) === 5;
}

function buildAudienceTabs(basePath, activeAudience, query = {}, user = null) {
  if (!user?.permissions?.view_adult_attendance) return [];
  return [
    { id: AUDIENCE_CHILDREN, label: 'Дети' },
    { id: AUDIENCE_ADULTS, label: 'Взрослые' },
  ].map((item) => ({
    ...item,
    active: item.id === activeAudience,
    href: audienceUrl(basePath, item.id, query),
  }));
}

function audienceUrl(basePath, audience, query = {}) {
  const params = new URLSearchParams();
  params.set('audience', audience);
  if (query.month) params.set('month', query.month);
  if (audience === AUDIENCE_CHILDREN && query.class) params.set('class', query.class);
  if (audience === AUDIENCE_ADULTS && query.department) params.set('department', query.department);
  const text = params.toString();
  return text ? `${basePath}?${text}` : basePath;
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
    audience: normalizeApiAudience(body.audience),
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
    occurred_label: event.occurred_label,
    attendance_date: event.attendance_date,
    actor_id: event.actor_id ? Number(event.actor_id) : null,
    source: event.source,
    audience: event.audience || AUDIENCE_CHILDREN,
    cancelled_at: event.cancelled_at || null,
    cancelled_by: event.cancelled_by ? Number(event.cancelled_by) : null,
    created_at: event.created_at,
    updated_at: event.updated_at,
  };
}

function buildAnalyticsKpiCards(analytics) {
  const kpi = analytics.kpi || {};
  const summary = analytics.class_summary || {};
  if (Number(analytics.metric_version || 1) === 2) {
    const hasScheduled = Number(kpi.scheduled_minutes || 0) > 0;
    return [
      {
        label: 'Посещаемость',
        value: hasScheduled ? `${Number(kpi.attendance_percent || 0)}%` : '—',
        hint: 'по опубликованному расписанию',
        border_class: hasScheduled ? 'border-emerald-500' : 'border-gray-300',
      },
      {
        label: 'Пропущено',
        value: formatMinutesAsHours(kpi.missed_minutes),
        hint: 'фактическое учебное время',
        border_class: Number(kpi.missed_minutes || 0) ? 'border-amber-500' : 'border-emerald-500',
      },
      {
        label: 'Нет отметки',
        value: formatMinutesAsHours(kpi.no_mark_minutes),
        hint: 'считается отсутствием',
        border_class: Number(kpi.no_mark_minutes || 0) ? 'border-red-500' : 'border-emerald-500',
      },
      {
        label: 'Конфликты',
        value: Number(analytics.quality?.conflicts || 0),
        hint: 'исключены из процента',
        border_class: Number(analytics.quality?.conflicts || 0) ? 'border-red-500' : 'border-emerald-500',
      },
      {
        label: 'Запланировано',
        value: formatMinutesAsHours(kpi.planned_absence_minutes),
        hint: `${Number(kpi.planned_absence_days || 0)} ученик-дн. · не входит в факт`,
        border_class: 'border-sky-500',
      },
    ];
  }
  const lateness = analytics.lateness || {};
  const withoutReason = Number(kpi.without_reason || 0);
  const needsAttention = Number(kpi.needs_attention || 0);
  const needsClarification = Number(kpi.needs_clarification || 0);
  const hasActivity = Boolean(analytics.has_activity);
  const hasAbsenceData = Boolean(analytics.has_data);
  const target = (condition, id, actionLabel) => (condition
    ? { href: `#${id}`, target_id: id, action_label: actionLabel }
    : {});

  return [
    {
      label: 'Посещаемость',
      value: `${Number(summary.attendance_percent || 0)}%`,
      border_class: Number(summary.attendance_percent || 0) ? 'border-emerald-500' : 'border-gray-300',
      ...target(hasActivity, 'lateness-analytics', 'Смотреть присутствие'),
    },
    {
      label: 'Отсутствующие',
      value: summary.absent_today_label || `${Number(summary.absent_today || 0)} учеников`,
      hint: 'сегодня',
      border_class: Number(summary.absent_today || 0) ? 'border-amber-500' : 'border-emerald-500',
      details: [
        { label: `без причины: ${withoutReason}`, tone_class: withoutReason ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600' },
        { label: `внимание: ${needsAttention}`, tone_class: needsAttention ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600' },
        { label: `уточнить: ${needsClarification}`, tone_class: needsClarification ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600' },
      ],
      ...target(hasAbsenceData, 'today-absences', 'Открыть список'),
    },
    {
      label: 'Опоздания',
      value: Number(summary.late_days || lateness.late_days_total || 0),
      hint: 'ученик-дней',
      border_class: Number(lateness.late_days_total || 0) ? 'border-amber-500' : 'border-emerald-500',
      ...target(Boolean(lateness.has_activity), 'lateness-analytics', 'Смотреть опоздания'),
    },
    {
      label: 'Вовремя',
      value: Number(summary.on_time_days || 0),
      hint: 'присутствие по расписанию',
      border_class: Number(summary.on_time_days || 0) ? 'border-emerald-500' : 'border-gray-300',
      ...target(Boolean(lateness.has_activity), 'lateness-analytics', 'Смотреть присутствие'),
    },
    {
      label: 'Дни отсутствия',
      value: Number(summary.absence_days || kpi.absence_days || 0),
      hint: 'ученик-день',
      border_class: 'border-indigo-500',
      ...target(hasAbsenceData, 'absence-calendar', 'Смотреть календарь'),
    },
  ];
}

function buildAdultAnalyticsKpiCards(analytics) {
  const kpi = analytics.kpi || {};
  const summary = analytics.class_summary || {};
  if (Number(analytics.metric_version || 1) === 2) {
    return [
      {
        label: 'В школе',
        value: kpi.onsite_hours_label || formatMinutesAsHours(kpi.onsite_minutes),
        hint: 'наблюдаемое время, без нормы',
        border_class: Number(kpi.onsite_minutes || 0) ? 'border-emerald-500' : 'border-gray-300',
      },
      {
        label: 'Дни с приходом',
        value: Number(kpi.present_days || 0),
        hint: 'по фактическим отметкам',
        border_class: Number(kpi.present_days || 0) ? 'border-emerald-500' : 'border-gray-300',
      },
      {
        label: 'Сегодня пришли',
        value: summary.present_today_label || Number(kpi.present_today || 0),
        border_class: Number(kpi.present_today || 0) ? 'border-emerald-500' : 'border-gray-300',
      },
      {
        label: 'Сегодня ушли',
        value: summary.departed_today_label || Number(kpi.departed_today || 0),
        border_class: Number(kpi.departed_today || 0) ? 'border-slate-500' : 'border-gray-300',
      },
      {
        label: 'Конфликты',
        value: Number(kpi.open_conflicts || 0),
        hint: 'требуют решения',
        border_class: Number(kpi.open_conflicts || 0) ? 'border-red-500' : 'border-emerald-500',
      },
    ];
  }
  const withoutReason = Number(kpi.without_reason || 0);
  const needsAttention = Number(kpi.needs_attention || 0);
  const needsClarification = Number(kpi.needs_clarification || 0);
  const hasPeople = Number(kpi.people_total || 0) > 0;
  const hasAbsenceData = Boolean(analytics.has_data);

  return [
    {
      label: 'Присутствие',
      value: `${Number(kpi.attendance_percent || 0)}%`,
      hint: 'по рабочим дням',
      border_class: Number(kpi.attendance_percent || 0) ? 'border-emerald-500' : 'border-gray-300',
      ...(hasPeople ? { href: '#adult-people', target_id: 'adult-people', action_label: 'Смотреть сотрудников' } : {}),
    },
    {
      label: 'Сегодня пришли',
      value: summary.present_today_label || Number(kpi.present_today || 0),
      hint: 'сейчас в школе',
      border_class: Number(kpi.present_today || 0) ? 'border-emerald-500' : 'border-gray-300',
      ...(hasPeople ? { href: '#adult-people', target_id: 'adult-people', action_label: 'Открыть список' } : {}),
    },
    {
      label: 'Сегодня ушли',
      value: summary.departed_today_label || Number(kpi.departed_today || 0),
      hint: 'последняя отметка',
      border_class: Number(kpi.departed_today || 0) ? 'border-slate-500' : 'border-gray-300',
    },
    {
      label: 'Отсутствуют',
      value: summary.absent_today_label || Number(kpi.absent_today || 0),
      hint: 'сегодня',
      border_class: Number(kpi.absent_today || 0) ? 'border-amber-500' : 'border-emerald-500',
      details: [
        { label: `без причины: ${withoutReason}`, tone_class: withoutReason ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600' },
        { label: `внимание: ${needsAttention}`, tone_class: needsAttention ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600' },
        { label: `уточнить: ${needsClarification}`, tone_class: needsClarification ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600' },
      ],
      ...(hasAbsenceData ? { href: '#adult-today-absences', target_id: 'adult-today-absences', action_label: 'Открыть отсутствия' } : {}),
    },
    {
      label: 'Дни отсутствия',
      value: Number(kpi.absence_days || 0),
      hint: 'сотрудник-день',
      border_class: 'border-indigo-500',
      ...(hasAbsenceData ? { href: '#adult-calendar', target_id: 'adult-calendar', action_label: 'Смотреть календарь' } : {}),
    },
  ];
}

function formatMinutesAsHours(value) {
  const hours = Math.round((Number(value || 0) / 60) * 10) / 10;
  return `${hours.toLocaleString('ru-RU')} ч.`;
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

function buildAttendanceSummaryFilters(summary, context = {}) {
  if (!summary) return [];
  const filters = [
    {
      id: 'all',
      label: 'В классе',
      value: Number(summary.students_total || 0),
      value_class: 'text-gray-900',
      detail: '',
      detail_class: 'text-gray-500',
    },
    {
      id: 'current',
      label: 'Отсутствующие',
      value: Number(summary.absent_students || 0),
      value_class: 'text-gray-900',
      detail: `внимание: ${Number(summary.needs_attention_count || 0)}`,
      detail_class: Number(summary.needs_attention_count || 0) ? 'text-red-700' : 'text-gray-500',
    },
    {
      id: 'missing',
      label: 'Без причины',
      value: Number(summary.without_reason_count || 0),
      value_class: 'text-amber-700',
      detail: '',
      detail_class: 'text-gray-500',
    },
  ];

  return filters.map((filter) => {
    const active = context.activeFilter === filter.id;
    return {
      ...filter,
      active,
      card_class: active
        ? 'border-indigo-500 bg-indigo-50 shadow-sm'
        : 'border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40',
      href: attendanceUrl({
        classId: context.classId,
        date: context.date,
        filter: filter.id,
      }),
    };
  });
}

function buildAttendanceFilterTable({ activeFilter, classId, date, absences = [] } = {}) {
  const visible = activeFilter === 'current' || activeFilter === 'missing';
  const title = activeFilter === 'missing' ? 'Без причины' : 'Отсутствующие';
  const filteredAbsences = visible
    ? absences.filter((absence) => activeFilter !== 'missing' || isWithoutReasonCode(absence.reason_code))
    : [];

  return {
    visible,
    title,
    count: filteredAbsences.length,
    empty_label: activeFilter === 'missing'
      ? 'За выбранный день отсутствий без причины нет.'
      : 'За выбранный день отсутствующих нет.',
    rows: filteredAbsences.map((absence) => ({
      ...absence,
      href: attendanceUrl({
        classId,
        studentId: absence.student_id,
        date,
        filter: activeFilter,
      }),
      reason_class: isWithoutReasonCode(absence.reason_code)
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-700',
      attention_class: absence.needs_attention ? 'bg-red-100 text-red-800' : 'bg-green-50 text-green-700',
    })),
  };
}

function toPublicAttendanceConflict(conflict) {
  if (!conflict) return null;
  return {
    id: conflict.id,
    student_id: Number(conflict.student_id),
    class_id: Number(conflict.class_id),
    student_name: conflict.student_name || '',
    class_name: conflict.class_name || '',
    absence_id: Number(conflict.absence_id),
    presence_event_id: Number(conflict.presence_event_id),
    conflict_type: conflict.conflict_type,
    status: conflict.status,
    status_label: conflict.status_label,
    resolution_code: conflict.resolution_code || null,
    attendance_date: conflict.attendance_date,
    occurred_at: conflict.occurred_at,
    starts_at: conflict.starts_at,
    ends_at: conflict.ends_at,
    reason_code: conflict.reason_code,
    reason_name: conflict.reason_name,
    audience: conflict.audience,
    resolved_by: conflict.resolved_by ? Number(conflict.resolved_by) : null,
    resolved_at: conflict.resolved_at || null,
    created_at: conflict.created_at,
  };
}

function buildFilters(activeFilter, context = {}) {
  const filters = [
    { id: 'all', name: 'Все' },
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
