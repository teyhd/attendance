import crypto from 'node:crypto';
import { verifyInternalServiceRequest } from './internal-service-auth.mjs';
import { getPublishedMentorWeeks, publishedMentorDay, schoolSqlNow } from './mentor-work.mjs';

const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const ids = values => [...new Set(values.filter(positiveId).map(Number))];
const placeholders = values => values.map(() => '?').join(',');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const iso = value => value ? `${String(value).replace(' ', 'T')}+03:00` : null;

export function parsePortalRequest(body, now = new Date()) {
  const date = schoolSqlNow(now).slice(0, 10);
  if (!positiveId(body?.actorId) || body?.date !== date) fail(400, 'invalid_actor_or_date');
  if (!['personal', 'school'].includes(body?.context)) fail(400, 'invalid_context');
  if (!Array.isArray(body.studentIds) || body.studentIds.length > 1500 || body.studentIds.some(id => !positiveId(id))) fail(400, 'invalid_students');
  if (body.detail != null && !['conflicts', 'attention'].includes(body.detail)) fail(400, 'invalid_detail');
  const offset = Number(body.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) fail(400, 'invalid_offset');
  return { actorId: Number(body.actorId), date, context: body.context, studentIds: ids(body.studentIds), detail: body.detail, offset };
}

export function permittedPortalStudents(roles, requested, assigned, actorId) {
  if (roles.some(role => [2, 4, 5].includes(role))) return ids([...requested, ...assigned]);
  if (roles.includes(3)) return ids(assigned);
  if (roles.includes(1)) return [actorId];
  return [];
}

// This is a read model of physical observations, never an inferred lesson mark.
export function buildPortalStudents(people, events, absences, conflicts) {
  const byId = new Map(people.map(person => [String(person.id), {
    id: String(person.id), name: person.name, classId: String(person.classId ?? ''), className: person.className || '',
    lastEvent: null, absences: [], conflicts: 0,
  }]));
  for (const event of events) {
    const person = byId.get(String(event.student_id));
    if (!person) continue;
    const candidate = { type: event.event_type, at: iso(event.occurred_at), id: Number(event.id) };
    if (!person.lastEvent || candidate.at > person.lastEvent.at || (candidate.at === person.lastEvent.at && candidate.id > person.lastEvent.id)) person.lastEvent = candidate;
  }
  for (const absence of absences) {
    byId.get(String(absence.student_id))?.absences.push({
      id: String(absence.id), start: iso(absence.starts_at), end: iso(absence.ends_at),
      needsAttention: absence.attention_status === 'needs_attention', confirmation: absence.confirmation_status,
    });
  }
  for (const conflict of conflicts) {
    const person = byId.get(String(conflict.student_id));
    if (person) person.conflicts += Number(conflict.count ?? 1);
  }
  return [...byId.values()];
}

export async function loadPortalContext(executor, input, { serviceId = 13, now = new Date() } = {}) {
  const { actorId, date, context, studentIds, detail, offset } = parsePortalRequest(input, now);
  const [rights] = await executor.query(`SELECT DISTINCT r.role_id, u.type
    FROM sso.rights r JOIN sso.users u ON u.id = r.usr_id AND u.status = 1
    WHERE r.usr_id = ? AND r.srv_id = ?`, [actorId, serviceId]);
  const roles = rights.map(row => Number(row.role_id));
  if (!roles.some(role => [1, 2, 3, 4, 5].includes(role))) fail(403, 'attendance_forbidden');
  if (context === 'school' && !roles.includes(5)) fail(403, 'school_forbidden');
  const result = { schema: 1, date, generatedAt: now.toISOString(), schoolAllowed: roles.includes(5), students: [], assignedIds: [], shift: null, summary: [] };

  // Mentor assignments belong to Attendance. Tutor's narrower scope is supplied by
  // the schedule adapter; its optional mapping table is not present in this database.
  const [assigned] = roles.includes(3) ? await executor.query(`SELECT DISTINCT u.id
    FROM sso.users u WHERE u.status = 1 AND u.type = 1 AND (
      EXISTS (SELECT 1 FROM school_local.info_class_tutor ct WHERE ct.tutor_id = ? AND ct.class_id = u.kaf)
      OR EXISTS (SELECT 1 FROM school_local.info_student_nastavnik n WHERE n.nastavnik_id = ? AND n.stud_id = u.id))`,
  [actorId, actorId]) : [[]];
  result.assignedIds = assigned.map(row => String(row.id));
  let selected = permittedPortalStudents(roles, studentIds, assigned.map(row => row.id), actorId);

  if (context === 'school') {
    const [totals] = await executor.query(`SELECT 'conflicts' AS kind, COUNT(*) AS records, COUNT(DISTINCT c.student_id) AS children
      FROM attendance.presence_absence_conflicts c JOIN attendance.presence_events e ON e.id = c.presence_event_id
      JOIN sso.users u ON u.id = c.student_id AND u.status = 1 AND u.type = 1
      WHERE c.status = 'open' AND e.attendance_date = ?
      UNION ALL SELECT 'attention', COUNT(*), COUNT(DISTINCT p.student_id)
      FROM attendance.absence_periods p JOIN sso.users u ON u.id = p.student_id AND u.status = 1 AND u.type = 1
      WHERE p.deleted_at IS NULL AND p.starts_at < ? AND (p.ends_at IS NULL OR p.ends_at > ?)
      AND (p.attention_status = 'needs_attention' OR p.confirmation_status IN ('needs_clarification', 'system_conflict'))`,
    [date, `${date} 23:59:59`, `${date} 00:00:00`]);
    result.summary = totals.map(row => ({ kind: row.kind, count: Number(row.children), records: Number(row.records) }));
    if (!detail) return result;
    const [page] = detail === 'conflicts' ? await executor.query(`SELECT DISTINCT c.student_id AS id
      FROM attendance.presence_absence_conflicts c JOIN attendance.presence_events e ON e.id = c.presence_event_id
      JOIN sso.users u ON u.id = c.student_id AND u.status = 1 AND u.type = 1
      WHERE c.status = 'open' AND e.attendance_date = ? ORDER BY c.student_id LIMIT 50 OFFSET ?`, [date, offset])
      : await executor.query(`SELECT DISTINCT p.student_id AS id FROM attendance.absence_periods p
        JOIN sso.users u ON u.id = p.student_id AND u.status = 1 AND u.type = 1
        WHERE p.deleted_at IS NULL AND p.starts_at < ? AND (p.ends_at IS NULL OR p.ends_at > ?)
        AND (p.attention_status = 'needs_attention' OR p.confirmation_status IN ('needs_clarification', 'system_conflict'))
        ORDER BY p.student_id LIMIT 50 OFFSET ?`, [`${date} 23:59:59`, `${date} 00:00:00`, offset]);
    selected = page.map(row => Number(row.id));
    result.total = result.summary.find(row => row.kind === detail)?.count ?? 0;
  }

  if (selected.length) {
    const ph = placeholders(selected);
    const [[people], [events], [absences], [conflicts]] = await Promise.all([
      executor.query(`SELECT u.id, u.name, u.kaf AS classId, k.name AS className FROM sso.users u
        LEFT JOIN sso.kaf_name k ON k.id = u.kaf WHERE u.status = 1 AND u.type = 1 AND u.id IN (${ph}) ORDER BY u.name, u.id`, selected),
      executor.query(`SELECT id, student_id, event_type, DATE_FORMAT(occurred_at, '%Y-%m-%d %H:%i:%s') AS occurred_at
        FROM attendance.presence_events WHERE attendance_date = ? AND cancelled_at IS NULL AND occurred_at <= ? AND student_id IN (${ph})
        ORDER BY occurred_at, id`, [date, schoolSqlNow(now), ...selected]),
      executor.query(`SELECT id, student_id, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
        DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at, attention_status, confirmation_status
        FROM attendance.absence_periods WHERE deleted_at IS NULL AND starts_at < ? AND (ends_at IS NULL OR ends_at > ?)
        AND student_id IN (${ph}) ORDER BY starts_at, id`, [`${date} 23:59:59`, `${date} 00:00:00`, ...selected]),
      executor.query(`SELECT c.student_id, COUNT(*) AS count FROM attendance.presence_absence_conflicts c
        JOIN attendance.presence_events e ON e.id = c.presence_event_id WHERE c.status = 'open'
        AND e.attendance_date = ? AND c.student_id IN (${ph}) GROUP BY c.student_id`, [date, ...selected]),
    ]);
    result.students = buildPortalStudents(people, events, absences, conflicts);
  }
  if (context === 'personal' && roles.some(role => [3, 5].includes(role)) && Number(rights[0]?.type) === 3) {
    const weeks = await getPublishedMentorWeeks(executor, { start_date: date, end_date: date });
    const day = publishedMentorDay(weeks, String(actorId), date);
    result.shift = { status: !day.published ? 'unpublished' : day.shift ? 'scheduled' : 'unassigned',
      start: day.shift ? iso(`${date} ${day.shift[0]}:00`) : null, end: day.shift ? iso(`${date} ${day.shift[1]}:00`) : null };
  }
  return result;
}

export function registerMainportalContext(app, executor, options = {}) {
  app.post('/internal/v1/mainportal/context', async (req, res) => {
    res.set('Cache-Control', 'private, no-cache');
    const verified = verifyInternalServiceRequest({
      serviceName: req.headers['x-service-name'], timestamp: req.headers['x-service-timestamp'],
      signature: req.headers['x-service-signature'], rawBody: req.rawJsonBody,
      serviceKey: options.serviceKey ?? process.env.ATTENDANCE_MAINPORTAL_SERVICE_KEY, allowedServices: ['mainportal'],
    });
    if (!verified.ok) return res.status(verified.status).json({ error: verified.error });
    try {
      const data = await loadPortalContext(executor, req.body, { serviceId: Number(process.env.SSO_SERVICE_ID || 13), ...options });
      const etag = `"${crypto.createHash('sha256').update(JSON.stringify({ ...data, generatedAt: undefined })).digest('hex')}"`;
      res.set('ETag', etag).set('X-Checked-At', data.generatedAt);
      if (req.headers['if-none-match'] === etag) return res.status(304).end();
      return res.json(data);
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.status ? error.message : 'attendance_unavailable' });
    }
  });
}
