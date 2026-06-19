import mysql from 'mysql2';
import {
  buildMonthRange,
  compareClassNames,
  expandDateRangeWithinMonth,
  hoursWithinRange,
  normalizeAnalyticsMonth,
  percentOf,
} from './analytics.mjs';
import { buildActiveClassList, studentCountLabel } from './classes.mjs';
import {
  OTHER_REASON_CODE,
  WITHOUT_REASON_CODE,
  isOtherReasonCode,
  isWithoutReasonCode,
} from './absence-reasons.mjs';
import {
  PRESENCE_EVENT_TYPES,
  canCancelPresenceEvent,
  resolvePresenceToggle,
} from './presence.mjs';
import { buildLearningAnalytics } from './learning-analytics.mjs';
import { LATE_THRESHOLD_MINUTES, buildLateAnalytics } from './late-analytics.mjs';
import { buildRiskWorklist } from './risk-worklist.mjs';

const FAR_FUTURE = '9999-12-31 23:59:59';
const SCHOOL_DAY_FALLBACK_START = '09:00:00';
const SCHOOL_DAY_FALLBACK_END = '19:00:00';
const CLASS_CHART_COLORS = [
  '#2563eb',
  '#059669',
  '#d97706',
  '#0891b2',
  '#4f46e5',
  '#65a30d',
  '#0f766e',
  '#64748b',
  '#a16207',
  '#0369a1',
];
const REASON_BAR_COLORS = {
  illness: '#059669',
  family: '#2563eb',
  trip: '#7c3aed',
  [WITHOUT_REASON_CODE]: '#d97706',
  [OTHER_REASON_CODE]: '#f59e0b',
  default: '#0f766e',
};
const REASON_CELL_PALETTES = {
  illness: { bg: '#ecfdf5', border: '#86efac', text: '#065f46', strongBg: '#059669', strongText: '#ffffff' },
  family: { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8', strongBg: '#2563eb', strongText: '#ffffff' },
  trip: { bg: '#f5f3ff', border: '#c4b5fd', text: '#5b21b6', strongBg: '#7c3aed', strongText: '#ffffff' },
  [WITHOUT_REASON_CODE]: { bg: '#fef3c7', border: '#fde68a', text: '#92400e', strongBg: '#d97706', strongText: '#111827' },
  [OTHER_REASON_CODE]: { bg: '#fff7ed', border: '#fed7aa', text: '#9a3412', strongBg: '#f59e0b', strongText: '#111827' },
  attention: { bg: '#fee2e2', border: '#fecaca', text: '#991b1b', strongBg: '#dc2626', strongText: '#ffffff' },
  default: { bg: '#ecfeff', border: '#67e8f9', text: '#155e75', strongBg: '#0f766e', strongText: '#ffffff' },
};

const sets = {
  host: process.env.MDBHOST,
  user: process.env.DBUSER,
  password: process.env.DBPASS,
  database: process.env.DBNAMESUSR || undefined,
  charset: 'utf8mb4_general_ci',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: 100,
  maxIdle: 100,
  idleTimeout: 200,
  queueLimit: 0,
  enableKeepAlive: false,
  keepAliveInitialDelay: 0,
};

const usr = mysql.createPool(sets).promise();

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

export async function ensureAttendanceSchema() {
  await usr.query(`
    CREATE TABLE IF NOT EXISTS attendance.absence_reasons (
      code VARCHAR(32) NOT NULL,
      name VARCHAR(100) NOT NULL,
      is_excused TINYINT(1) NOT NULL DEFAULT 1,
      requires_attention TINYINT(1) NOT NULL DEFAULT 0,
      default_confirmation_status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
      sort_order INT NOT NULL DEFAULT 100,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await usr.query(`
    CREATE TABLE IF NOT EXISTS attendance.absence_periods (
      id INT NOT NULL AUTO_INCREMENT,
      student_id INT NOT NULL,
      class_id INT NOT NULL,
      starts_at DATETIME NOT NULL,
      ends_at DATETIME NULL,
      reason_code VARCHAR(32) NOT NULL,
      comment TEXT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'mentor',
      confirmation_status VARCHAR(32) NOT NULL DEFAULT 'confirmed',
      attention_status VARCHAR(32) NOT NULL DEFAULT 'normal',
      resolved_at DATETIME NULL,
      resolved_by INT NULL,
      created_by INT NULL,
      updated_by INT NULL,
      deleted_by INT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_absence_student_starts (student_id, starts_at),
      KEY idx_absence_class_starts (class_id, starts_at),
      KEY idx_absence_period_range (starts_at, ends_at),
      KEY idx_absence_deleted (deleted_at),
      KEY idx_absence_reason (reason_code),
      CONSTRAINT fk_absence_student
        FOREIGN KEY (student_id) REFERENCES sso.users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      CONSTRAINT fk_absence_class
        FOREIGN KEY (class_id) REFERENCES sso.kaf_name (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      CONSTRAINT fk_absence_reason
        FOREIGN KEY (reason_code) REFERENCES attendance.absence_reasons (code)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await ensureColumn('attendance', 'absence_reasons', 'requires_attention', "TINYINT(1) NOT NULL DEFAULT 0 AFTER is_excused");
  await ensureColumn('attendance', 'absence_reasons', 'default_confirmation_status', "VARCHAR(32) NOT NULL DEFAULT 'confirmed' AFTER requires_attention");
  await ensureColumn('attendance', 'absence_periods', 'source', "VARCHAR(32) NOT NULL DEFAULT 'mentor' AFTER comment");
  await ensureColumn('attendance', 'absence_periods', 'confirmation_status', "VARCHAR(32) NOT NULL DEFAULT 'confirmed' AFTER source");
  await ensureColumn('attendance', 'absence_periods', 'attention_status', "VARCHAR(32) NOT NULL DEFAULT 'normal' AFTER confirmation_status");
  await ensureColumn('attendance', 'absence_periods', 'resolved_at', 'DATETIME NULL AFTER attention_status');
  await ensureColumn('attendance', 'absence_periods', 'resolved_by', 'INT NULL AFTER resolved_at');
  await ensureIndex('attendance', 'absence_periods', 'idx_absence_attention', 'attention_status, resolved_at');
  await ensureIndex('attendance', 'absence_periods', 'idx_absence_resolution', 'resolved_by, resolved_at');

  await usr.query(`
    CREATE TABLE IF NOT EXISTS attendance.absence_period_events (
      id INT NOT NULL AUTO_INCREMENT,
      absence_id INT NOT NULL,
      actor_id INT NULL,
      event_type VARCHAR(32) NOT NULL,
      before_json LONGTEXT NULL,
      after_json LONGTEXT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_absence_events_absence (absence_id, created_at),
      KEY idx_absence_events_actor (actor_id, created_at),
      CONSTRAINT fk_absence_event_period
        FOREIGN KEY (absence_id) REFERENCES attendance.absence_periods (id)
        ON UPDATE CASCADE ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await usr.query(`
    CREATE TABLE IF NOT EXISTS attendance.presence_events (
      id INT NOT NULL AUTO_INCREMENT,
      student_id INT NOT NULL,
      class_id INT NOT NULL,
      event_type VARCHAR(16) NOT NULL,
      occurred_at DATETIME NOT NULL,
      attendance_date DATE NOT NULL,
      actor_id INT NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'tablet',
      cancelled_at TIMESTAMP NULL DEFAULT NULL,
      cancelled_by INT NULL,
      idempotency_key VARCHAR(64) NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_presence_date_class (attendance_date, class_id),
      KEY idx_presence_student_day_time (student_id, attendance_date, occurred_at),
      UNIQUE KEY idx_presence_idempotency (idempotency_key),
      CONSTRAINT fk_presence_student
        FOREIGN KEY (student_id) REFERENCES sso.users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      CONSTRAINT fk_presence_class
        FOREIGN KEY (class_id) REFERENCES sso.kaf_name (id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);
  await ensureIndex('attendance', 'presence_events', 'idx_presence_date_class', 'attendance_date, class_id');
  await ensureIndex('attendance', 'presence_events', 'idx_presence_student_day_time', 'student_id, attendance_date, occurred_at');
  await ensureUniqueIndex('attendance', 'presence_events', 'idx_presence_idempotency', 'idempotency_key');

  await usr.query(`
    INSERT INTO attendance.absence_reasons
      (code, name, is_excused, requires_attention, default_confirmation_status, sort_order, active)
    VALUES
      ('illness', 'Болезнь', 1, 0, 'confirmed', 10, 1),
      ('family', 'Семейные обстоятельства', 1, 0, 'confirmed', 20, 1),
      ('trip', 'Соревнования', 1, 0, 'confirmed', 30, 1),
      ('olympiad', 'Олимпиада', 1, 0, 'confirmed', 40, 1),
      ('medical_checkup', 'Медосмотр', 1, 0, 'confirmed', 50, 1),
      ('excused', 'Уважительная причина', 1, 0, 'reported', 60, 1),
      ('${OTHER_REASON_CODE}', 'Другое', 0, 0, 'reported', 70, 1),
      ('${WITHOUT_REASON_CODE}', 'Без причины', 0, 1, 'needs_clarification', 80, 1)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      is_excused = VALUES(is_excused),
      requires_attention = VALUES(requires_attention),
      default_confirmation_status = VALUES(default_confirmation_status),
      sort_order = VALUES(sort_order),
      active = VALUES(active)
  `);

  await usr.query(`
    CREATE OR REPLACE VIEW attendance.v_absence_periods AS
    SELECT
      p.id,
      p.student_id,
      p.class_id,
      p.starts_at,
      p.ends_at,
      p.reason_code,
      r.name AS reason_name,
      r.is_excused,
      p.source,
      p.confirmation_status,
      p.attention_status,
      p.resolved_at,
      p.resolved_by,
      p.comment,
      p.created_by,
      p.created_at,
      p.updated_at
    FROM attendance.absence_periods p
    JOIN attendance.absence_reasons r ON r.code = p.reason_code
    WHERE p.deleted_at IS NULL
  `);

  await usr.query(`
    CREATE OR REPLACE VIEW attendance.v_absence_daily_summary AS
    SELECT
      p.class_id,
      DATE(p.starts_at) AS starts_date,
      COUNT(*) AS absence_count,
      COUNT(DISTINCT p.student_id) AS absent_students,
      SUM(p.reason_code = '${WITHOUT_REASON_CODE}') AS without_reason_count,
      SUM(p.attention_status = 'needs_attention') AS needs_attention_count,
      SUM(r.is_excused = 1) AS excused_count
    FROM attendance.absence_periods p
    JOIN attendance.absence_reasons r ON r.code = p.reason_code
    WHERE p.deleted_at IS NULL
    GROUP BY p.class_id, DATE(p.starts_at)
  `);
}

async function ensureColumn(schema, table, column, definition) {
  const [rows] = await usr.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1`,
    [schema, table, column],
  );
  if (!rows.length) {
    await usr.query(`ALTER TABLE ${schema}.${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function ensureIndex(schema, table, indexName, columnsSql) {
  const [rows] = await usr.query(
    `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [schema, table, indexName],
  );
  if (!rows.length) {
    await usr.query(`ALTER TABLE ${schema}.${table} ADD KEY ${indexName} (${columnsSql})`);
  }
}

async function ensureUniqueIndex(schema, table, indexName, columnsSql) {
  const [rows] = await usr.query(
    `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [schema, table, indexName],
  );
  if (!rows.length) {
    await usr.query(`ALTER TABLE ${schema}.${table} ADD UNIQUE KEY ${indexName} (${columnsSql})`);
  }
}

export async function getClasses() {
  const [rows] = await usr.query(
    `SELECT
        CAST(k.id AS CHAR) AS id,
        k.name,
        COUNT(u.id) AS students_count
       FROM sso.kaf_name k
       LEFT JOIN sso.users u
         ON u.kaf = k.id
        AND u.type = 1
        AND u.status = 1
      WHERE k.type = 1
        AND k.id > 0
      GROUP BY k.id, k.name`,
  );
  return buildActiveClassList(rows);
}

export async function getMentorClassIds(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return [];

  const [rows] = await usr.query(
    `SELECT DISTINCT CAST(t.class_id AS CHAR) AS id
       FROM school_local.info_class_tutor t
       JOIN sso.kaf_name k ON k.id = t.class_id
      WHERE t.tutor_id = ?
        AND t.class_id IS NOT NULL
        AND k.type = 1
        AND k.id > 0
      ORDER BY
        CASE WHEN NULLIF(REGEXP_SUBSTR(k.name, '^[0-9]+'), '') IS NULL THEN 1 ELSE 0 END,
        CAST(NULLIF(REGEXP_SUBSTR(k.name, '^[0-9]+'), '') AS UNSIGNED),
        k.name,
        k.id`,
    [id],
  );
  return rows.map((row) => String(row.id));
}

export async function getStudentsByClass(classId) {
  const [rows] = await usr.query(
    `SELECT
        CAST(id AS CHAR) AS id,
        COALESCE(NULLIF(display_name_custom, ''), NULLIF(nickname, ''), NULLIF(msgnickname, ''), name) AS name,
        CAST(kaf AS CHAR) AS classId
       FROM sso.users
      WHERE type = 1 AND status = 1 AND kaf = ?
      ORDER BY name`,
    [classId],
  );
  return rows;
}

export async function getStudentById(id) {
  const [rows] = await usr.query(
    `SELECT
        CAST(id AS CHAR) AS id,
        COALESCE(NULLIF(display_name_custom, ''), NULLIF(nickname, ''), NULLIF(msgnickname, ''), name) AS name,
        CAST(kaf AS CHAR) AS classId
       FROM sso.users
      WHERE type = 1 AND status = 1 AND id = ?
      LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

export async function getPresenceBoard({ date } = {}) {
  const selectedDate = normalizeDateOnly(date || todayDate());
  const nowSql = sqlNow();
  const [classes, students, events, absences, schoolDay] = await Promise.all([
    getClasses(),
    getPresenceStudents(),
    listPresenceEventsForDate(selectedDate),
    listPresenceAbsencesForDate(selectedDate),
    getSchoolDayBounds(selectedDate),
  ]);
  const latestByStudent = latestPresenceEventMap(events);
  const firstArrivalByStudent = firstPresenceArrivalMap(events);
  const absencesByStudent = presenceAbsencesByStudent(absences);
  const classBuckets = new Map(classes.map((classItem) => [
    String(classItem.id),
    {
      ...classItem,
      anchor: `presence-class-${classItem.id}`,
      students_label: studentCountLabel(classItem.students_count),
      students: [],
    },
  ]));

  for (const student of students) {
    const classBucket = classBuckets.get(String(student.classId));
    if (!classBucket) continue;
    const latestEvent = latestByStudent.get(String(student.id)) || null;
    const absence = presenceAbsenceForStudent(absencesByStudent.get(String(student.id)), selectedDate, nowSql);
    const firstArrival = firstArrivalByStudent.get(String(student.id)) || null;
    classBucket.students.push({
      ...student,
      state: presenceBoardState({
        latestEvent,
        absence,
        firstArrival,
        schoolDay,
      }),
    });
  }

  const boardClasses = [...classBuckets.values()].filter((classItem) => classItem.students.length > 0);
  const totals = boardClasses.reduce((acc, classItem) => {
    acc.classes += 1;
    acc.students += classItem.students.length;
    acc.present += classItem.students.filter((student) => student.state.is_present).length;
    return acc;
  }, { classes: 0, students: 0, present: 0 });

  return {
    date: selectedDate,
    date_label: formatDateLabel(selectedDate),
    classes: boardClasses,
    totals,
  };
}

export async function togglePresenceEvent({ studentId, classId, actorId, idempotencyKey } = {}) {
  const student = await assertPresenceStudent(studentId, classId);
  const nowSql = sqlNow();
  const attendanceDate = dateOnlyFromSql(nowSql);
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
  const conn = await usr.getConnection();
  let lockAcquired = false;

  try {
    await conn.beginTransaction();
    lockAcquired = await acquirePresenceLock(conn, student.id, attendanceDate);
    if (!lockAcquired) {
      throw new ValidationError('Повторите нажатие через секунду', 409);
    }

    if (normalizedIdempotencyKey) {
      const existing = await getPresenceEventByIdempotencyKey(conn, normalizedIdempotencyKey);
      if (existing) {
        await conn.commit();
        return {
          event: existing,
          state: presenceStateFromEvent(existing),
          duplicate: true,
        };
      }
    }

    const latestEvent = await getLatestPresenceEventForUpdate(conn, student.id, attendanceDate);
    const decision = resolvePresenceToggle({ latestEvent, now: nowSql });
    if (!decision.shouldInsert) {
      await conn.commit();
      return {
        event: latestEvent,
        state: presenceStateFromEvent(latestEvent),
        duplicate: true,
      };
    }

    const [result] = await conn.query(
      `INSERT INTO attendance.presence_events
        (student_id, class_id, event_type, occurred_at, attendance_date, actor_id, source, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, 'tablet', ?)`,
      [
        student.id,
        student.classId,
        decision.eventType,
        nowSql,
        attendanceDate,
        actorId || null,
        normalizedIdempotencyKey,
      ],
    );
    const event = await getPresenceEventById(conn, result.insertId);
    await conn.commit();
    return {
      event,
      state: presenceStateFromEvent(event),
      duplicate: false,
    };
  } catch (err) {
    await conn.rollback();
    if (isDuplicateKeyError(err) && normalizedIdempotencyKey) {
      const event = await getPresenceEventByIdempotencyKey(usr, normalizedIdempotencyKey);
      if (event) {
        return {
          event,
          state: presenceStateFromEvent(event),
          duplicate: true,
        };
      }
    }
    throw err;
  } finally {
    if (lockAcquired) {
      await releasePresenceLock(conn, student.id, attendanceDate);
    }
    conn.release();
  }
}

export async function cancelPresenceEvent(eventId, actorId) {
  const id = toPositiveInt(eventId, 'eventId');
  const conn = await usr.getConnection();
  let lockAcquired = false;
  let lockStudentId = '';
  let lockDate = '';

  try {
    await conn.beginTransaction();
    const event = await getActivePresenceEventByIdForUpdate(conn, id);
    if (!event) {
      await conn.commit();
      return null;
    }

    lockStudentId = event.student_id;
    lockDate = event.attendance_date;
    lockAcquired = await acquirePresenceLock(conn, lockStudentId, lockDate);
    if (!lockAcquired) {
      throw new ValidationError('Повторите отмену через секунду', 409);
    }

    const latestEvent = await getLatestPresenceEventForUpdate(conn, lockStudentId, lockDate);
    if (!canCancelPresenceEvent(event, latestEvent)) {
      throw new ValidationError('Можно отменить только последнюю отметку ученика', 409);
    }

    await conn.query(
      `UPDATE attendance.presence_events
          SET cancelled_at = CURRENT_TIMESTAMP,
              cancelled_by = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND cancelled_at IS NULL`,
      [actorId || null, id],
    );
    const newLatestEvent = await getLatestPresenceEventForUpdate(conn, lockStudentId, lockDate);
    await conn.commit();
    return {
      event,
      state: presenceStateFromEvent(newLatestEvent),
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    if (lockAcquired) {
      await releasePresenceLock(conn, lockStudentId, lockDate);
    }
    conn.release();
  }
}

export async function getAbsenceReasons({ includeInactive = false } = {}) {
  const [rows] = await usr.query(
    `SELECT
        code,
        name,
        is_excused AS isExcused,
        requires_attention AS requiresAttention,
        default_confirmation_status AS defaultConfirmationStatus,
        active
       FROM attendance.absence_reasons
      ${includeInactive ? '' : 'WHERE active = 1'}
      ORDER BY sort_order, name`,
  );
  return rows.map((row) => ({
    ...row,
    id: row.code,
    isExcused: Boolean(row.isExcused),
    requiresAttention: Boolean(row.requiresAttention),
    active: Boolean(row.active),
  }));
}

export async function listAbsencePeriods(filters = {}) {
  const where = ['p.deleted_at IS NULL'];
  const params = [];

  if (filters.studentId) {
    where.push('p.student_id = ?');
    params.push(filters.studentId);
  }

  if (filters.classId) {
    where.push('p.class_id = ?');
    params.push(filters.classId);
  }

  if (filters.from) {
    const from = normalizeDateTime(filters.from, { field: 'from', dateOnlyEnd: false });
    where.push('COALESCE(p.ends_at, ?) >= ?');
    params.push(FAR_FUTURE, from);
  }

  if (filters.to) {
    const to = normalizeDateTime(filters.to, { field: 'to', dateOnlyEnd: true });
    where.push('p.starts_at <= ?');
    params.push(to);
  }

  if (filters.currentOnly) {
    const now = sqlNow();
    where.push('p.starts_at <= ?');
    where.push('COALESCE(p.ends_at, ?) >= ?');
    params.push(now, FAR_FUTURE, now);
  }

  if (filters.currentOrFuture) {
    const now = sqlNow();
    where.push('COALESCE(p.ends_at, ?) >= ?');
    params.push(FAR_FUTURE, now);
  }

  const limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Math.min(500, Number(filters.limit))) : 250;
  params.push(limit);

  const [rows] = await usr.query(
    `${absenceSelectSql()}
      WHERE ${where.join(' AND ')}
      ORDER BY p.starts_at DESC, p.id DESC
      LIMIT ?`,
    params,
  );

  return rows.map(mapAbsencePeriod);
}

export async function getAbsencePeriodById(id) {
  const [rows] = await usr.query(
    `${absenceSelectSql()}
      WHERE p.id = ? AND p.deleted_at IS NULL
      LIMIT 1`,
    [id],
  );
  return rows[0] ? mapAbsencePeriod(rows[0]) : null;
}

export async function createAbsencePeriod(input) {
  const data = await validateAbsenceInput(input);

  await assertNoOverlap({
    studentId: data.studentId,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
  });

  const [result] = await usr.query(
    `INSERT INTO attendance.absence_periods
      (student_id, class_id, starts_at, ends_at, reason_code, comment, source, confirmation_status, attention_status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.studentId,
      data.classId,
      data.startsAt,
      data.endsAt,
      data.reasonCode,
      data.comment,
      data.source,
      data.confirmationStatus,
      data.attentionStatus,
      data.actorId,
      data.actorId,
    ],
  );

  const created = await getAbsencePeriodById(result.insertId);
  await recordAbsenceEvent({
    absenceId: result.insertId,
    actorId: data.actorId,
    eventType: 'created',
    before: null,
    after: created,
  });
  return created;
}

export async function updateAbsencePeriod(id, input) {
  const existing = await getAbsencePeriodById(id);
  if (!existing) return null;

  const data = await validateAbsenceInput({
    studentId: input.studentId ?? existing.student_id,
    classId: input.classId ?? existing.class_id,
    startsAt: input.startsAt ?? existing.starts_at,
    endsAt: input.endsAt ?? existing.ends_at,
    reasonCode: input.reasonCode ?? existing.reason_code,
    comment: input.comment ?? existing.comment,
    source: input.source ?? existing.source,
    confirmationStatus: input.confirmationStatus ?? existing.confirmation_status,
    attentionStatus: input.attentionStatus ?? existing.attention_status,
    resolvedAt: input.resolvedAt ?? existing.resolved_at,
    resolvedBy: input.resolvedBy ?? existing.resolved_by,
    actorId: input.actorId,
  });

  await assertNoOverlap({
    studentId: data.studentId,
    startsAt: data.startsAt,
    endsAt: data.endsAt,
    excludeId: id,
  });

  await usr.query(
    `UPDATE attendance.absence_periods
        SET student_id = ?,
            class_id = ?,
            starts_at = ?,
            ends_at = ?,
            reason_code = ?,
            comment = ?,
            source = ?,
            confirmation_status = ?,
            attention_status = ?,
            resolved_at = ?,
            resolved_by = ?,
            updated_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    [
      data.studentId,
      data.classId,
      data.startsAt,
      data.endsAt,
      data.reasonCode,
      data.comment,
      data.source,
      data.confirmationStatus,
      data.attentionStatus,
      data.resolvedAt,
      data.resolvedBy,
      data.actorId,
      id,
    ],
  );

  const updated = await getAbsencePeriodById(id);
  await recordAbsenceEvent({
    absenceId: id,
    actorId: data.actorId,
    eventType: existing.attention_status !== updated.attention_status ? 'status_changed' : 'updated',
    before: existing,
    after: updated,
  });
  return updated;
}

export async function softDeleteAbsencePeriod(id, actorId) {
  const existing = await getAbsencePeriodById(id);
  const [result] = await usr.query(
    `UPDATE attendance.absence_periods
        SET deleted_at = CURRENT_TIMESTAMP,
            deleted_by = ?,
            updated_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    [actorId || null, actorId || null, id],
  );
  if (result.affectedRows > 0 && existing) {
    await recordAbsenceEvent({
      absenceId: id,
      actorId: actorId || null,
      eventType: 'deleted',
      before: existing,
      after: null,
    });
  }
  return result.affectedRows > 0;
}

export async function resolveAbsenceAttention(id, actorId) {
  const existing = await getAbsencePeriodById(id);
  if (!existing) return null;

  await usr.query(
    `UPDATE attendance.absence_periods
        SET attention_status = 'resolved',
            resolved_at = CURRENT_TIMESTAMP,
            resolved_by = ?,
            updated_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
    [actorId || null, actorId || null, id],
  );

  const updated = await getAbsencePeriodById(id);
  await recordAbsenceEvent({
    absenceId: id,
    actorId: actorId || null,
    eventType: 'status_changed',
    before: existing,
    after: updated,
  });
  return updated;
}

export async function getAttendanceSummary({ classId, date } = {}) {
  const selectedDate = normalizeDateOnly(date || todayDate());
  const dayStart = `${selectedDate} 00:00:00`;
  const dayEnd = `${selectedDate} 23:59:59`;
  const params = [classId, FAR_FUTURE, dayStart, dayEnd];

  const [studentRows] = await usr.query(
    `SELECT COUNT(*) AS total
       FROM sso.users
      WHERE type = 1 AND status = 1 AND kaf = ?`,
    [classId],
  );

  const [absenceRows] = await usr.query(
    `SELECT
        COUNT(*) AS periods_count,
        COUNT(DISTINCT student_id) AS absent_students,
        SUM(reason_code = '${WITHOUT_REASON_CODE}') AS without_reason_count,
        SUM(attention_status = 'needs_attention') AS needs_attention_count,
        SUM(confirmation_status = 'needs_clarification') AS needs_clarification_count,
        SUM(source = 'diary' OR confirmation_status = 'system_conflict') AS integration_conflicts_count
       FROM attendance.absence_periods
      WHERE class_id = ?
        AND deleted_at IS NULL
        AND COALESCE(ends_at, ?) >= ?
        AND starts_at <= ?`,
    params,
  );

  const row = absenceRows[0] || {};
  return {
    class_id: String(classId || ''),
    date: selectedDate,
    students_total: Number(studentRows[0]?.total || 0),
    absent_students: Number(row.absent_students || 0),
    periods_count: Number(row.periods_count || 0),
    without_reason_count: Number(row.without_reason_count || 0),
    needs_attention_count: Number(row.needs_attention_count || 0),
    needs_clarification_count: Number(row.needs_clarification_count || 0),
    integration_conflicts_count: Number(row.integration_conflicts_count || 0),
  };
}

async function getPresenceStudents() {
  const [rows] = await usr.query(
    `SELECT
        CAST(u.id AS CHAR) AS id,
        COALESCE(NULLIF(u.display_name_custom, ''), NULLIF(u.nickname, ''), NULLIF(u.msgnickname, ''), u.name) AS name,
        CAST(u.kaf AS CHAR) AS classId,
        k.name AS className
       FROM sso.users u
       JOIN sso.kaf_name k ON k.id = u.kaf
      WHERE u.type = 1
        AND u.status = 1
        AND u.kaf > 0
        AND k.type = 1
      ORDER BY
        CASE WHEN NULLIF(REGEXP_SUBSTR(k.name, '^[0-9]+'), '') IS NULL THEN 1 ELSE 0 END,
        CAST(NULLIF(REGEXP_SUBSTR(k.name, '^[0-9]+'), '') AS UNSIGNED),
        k.name,
        COALESCE(NULLIF(u.display_name_custom, ''), NULLIF(u.nickname, ''), NULLIF(u.msgnickname, ''), u.name),
        u.id`,
  );
  return rows;
}

async function listPresenceEventsForDate(date) {
  const [rows] = await usr.query(
    `${presenceEventSelectSql()}
      WHERE e.attendance_date = ?
        AND e.cancelled_at IS NULL
      ORDER BY e.student_id, e.occurred_at, e.id`,
    [date],
  );
  return rows.map(mapPresenceEvent);
}

async function listPresenceAbsencesForDate(date) {
  const dayStart = `${date} 00:00:00`;
  const dayEnd = `${date} 23:59:59`;
  const [rows] = await usr.query(
    `${absenceSelectSql()}
      WHERE p.deleted_at IS NULL
        AND COALESCE(p.ends_at, ?) >= ?
        AND p.starts_at <= ?
        AND u.type = 1
        AND u.status = 1
        AND k.type = 1
      ORDER BY p.starts_at, p.id`,
    [FAR_FUTURE, dayStart, dayEnd],
  );
  return rows.map(mapAbsencePeriod);
}

function latestPresenceEventMap(events) {
  const map = new Map();
  for (const event of events || []) {
    map.set(String(event.student_id), event);
  }
  return map;
}

function firstPresenceArrivalMap(events) {
  const map = new Map();
  for (const event of events || []) {
    if (event.event_type !== PRESENCE_EVENT_TYPES.ARRIVAL) continue;
    const studentId = String(event.student_id);
    if (!map.has(studentId)) map.set(studentId, event);
  }
  return map;
}

function presenceAbsencesByStudent(absences) {
  const map = new Map();
  for (const absence of absences || []) {
    const studentId = String(absence.student_id);
    if (!map.has(studentId)) map.set(studentId, []);
    map.get(studentId).push(absence);
  }
  return map;
}

function presenceAbsenceForStudent(absences = [], selectedDate, nowSql) {
  if (!absences.length) return null;
  if (selectedDate === dateOnlyFromSql(nowSql)) {
    return absences.find((absence) => isAbsenceActiveAt(absence, nowSql)) || null;
  }
  return absences[0] || null;
}

function isAbsenceActiveAt(absence, nowSql) {
  const startsAt = String(absence?.starts_at || '');
  const endsAt = String(absence?.ends_at || FAR_FUTURE);
  return startsAt <= nowSql && endsAt >= nowSql;
}

function presenceBoardState({ latestEvent, absence, firstArrival, schoolDay } = {}) {
  const state = presenceStateFromEvent(latestEvent);
  if (absence) {
    return {
      ...state,
      is_present: false,
      status_code: 'absent',
      status_badge_label: 'Отсутствует',
      status_detail: [absence.reason_name, absence.period_label].filter(Boolean).join(' · '),
    };
  }
  if (state.is_present && isLateArrival(firstArrival, schoolDay)) {
    return {
      ...state,
      status_code: 'late',
      status_badge_label: 'Опоздал',
      status_detail: firstArrival.occurred_label || firstArrival.occurred_time || '',
    };
  }
  return state;
}

function isLateArrival(firstArrival, schoolDay) {
  if (!schoolDay?.from_schedule || !firstArrival?.occurred_at || !schoolDay.starts_at) return false;
  const arrivalMs = parseSqlDateTimeMs(firstArrival.occurred_at);
  const startsMs = parseSqlDateTimeMs(schoolDay.starts_at);
  if (!Number.isFinite(arrivalMs) || !Number.isFinite(startsMs)) return false;
  return ((arrivalMs - startsMs) / 60_000) > LATE_THRESHOLD_MINUTES;
}

export async function getTodayAbsenceOverview({ date, now, classId } = {}) {
  const selectedDate = normalizeDateOnly(date || todayDate());
  const nowSql = normalizeDateTime(now || sqlNow(), { field: 'now', required: true });
  const selectedClassId = String(classId || '').trim();
  const dayStart = `${selectedDate} 00:00:00`;
  const dayEnd = `${selectedDate} 23:59:59`;
  const studentWhere = [
    'type = 1',
    'status = 1',
    'kaf IS NOT NULL',
  ];
  const studentParams = [];
  const absenceWhere = [
    'p.deleted_at IS NULL',
    'u.type = 1',
    'u.status = 1',
    'COALESCE(p.ends_at, ?) >= ?',
    'p.starts_at <= ?',
  ];
  const absenceParams = [FAR_FUTURE, dayStart, dayEnd];

  if (selectedClassId && selectedClassId !== 'all') {
    studentWhere.push('kaf = ?');
    studentParams.push(selectedClassId);
    absenceWhere.push('p.class_id = ?');
    absenceParams.push(selectedClassId);
  }

  const [studentCountRows, absenceRows] = await Promise.all([
    usr.query(
      `SELECT CAST(kaf AS CHAR) AS class_id, COUNT(*) AS students_total
         FROM sso.users
        WHERE ${studentWhere.join(' AND ')}
        GROUP BY kaf`,
      studentParams,
    ),
    usr.query(
      `${absenceSelectSql()}
        WHERE ${absenceWhere.join(' AND ')}
        ORDER BY k.name, u.name, p.starts_at, p.id`,
      absenceParams,
    ),
  ]);

  const studentsByClass = new Map(
    studentCountRows[0].map((row) => [String(row.class_id), Number(row.students_total || 0)]),
  );
  const classBuckets = new Map();

  for (const absence of absenceRows[0].map(mapAbsencePeriod)) {
    const classId = String(absence.class_id || '');
    const studentId = String(absence.student_id || '');
    if (!classId || !studentId) continue;

    const classBucket = ensureTodayClassBucket(classBuckets, absence, studentsByClass);
    if (!classBucket.studentBuckets.has(studentId)) {
      classBucket.studentBuckets.set(studentId, {
        student_id: studentId,
        student_name: absence.student_name,
        periods: [],
      });
    }
    classBucket.studentBuckets.get(studentId).periods.push(absence);
  }

  const classes = Array.from(classBuckets.values()).map((classBucket) => {
    const students = Array.from(classBucket.studentBuckets.values())
      .map((studentBucket) => buildTodayStudentRow(studentBucket, selectedDate, nowSql))
      .sort(compareTodayStudentRows);
    const absentNow = students.filter((student) => student.is_now).length;
    const withoutReason = students.filter((student) => student.without_reason).length;
    const needsAttention = students.filter((student) => student.needs_attention).length;

    return {
      id: classBucket.class_id,
      name: classBucket.class_name,
      class_id: classBucket.class_id,
      class_name: classBucket.class_name,
      students_total: classBucket.students_total,
      absent_today: students.length,
      absent_now: absentNow,
      without_reason: withoutReason,
      needs_attention: needsAttention,
      href: attendanceHref({ classId: classBucket.class_id, date: selectedDate }),
      summary_label: `Класс ${classBucket.class_name} · ${students.length} сегодня · ${absentNow} сейчас`,
      students,
    };
  }).sort((a, b) => compareClassNames(a.class_name, b.class_name));

  const students = classes.flatMap((classItem) => classItem.students.map((student) => ({
    ...student,
    class_id: classItem.class_id,
    class_name: classItem.class_name,
  }))).sort((a, b) => (
    compareClassNames(a.class_name, b.class_name)
    || a.student_name.localeCompare(b.student_name, 'ru')
  ));

  return {
    date: selectedDate,
    date_label: formatDateLabel(selectedDate),
    now: nowSql,
    has_absences: classes.length > 0,
    students,
    totals: {
      classes_with_absences: classes.length,
      absent_students_today: classes.reduce((sum, row) => sum + row.absent_today, 0),
      absent_students_now: classes.reduce((sum, row) => sum + row.absent_now, 0),
      without_reason: classes.reduce((sum, row) => sum + row.without_reason, 0),
      needs_attention: classes.reduce((sum, row) => sum + row.needs_attention, 0),
    },
    classes,
  };
}

export async function getStudentContext(studentId, { days = 30 } = {}) {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ValidationError('Ученик не найден', 404);
  }

  const from = daysAgoDateTime(safeDays);
  const [rows] = await usr.query(
    `${absenceSelectSql()}
      WHERE p.student_id = ?
        AND p.deleted_at IS NULL
        AND COALESCE(p.ends_at, ?) >= ?
      ORDER BY p.starts_at DESC, p.id DESC
      LIMIT 50`,
    [studentId, FAR_FUTURE, from],
  );
  const absences = rows.map(mapAbsencePeriod);
  const lastComment = absences.find((absence) => absence.comment)?.comment || '';

  return {
    student,
    days: safeDays,
    absence_count: absences.length,
    needs_attention_count: absences.filter((absence) => absence.attention_status === 'needs_attention').length,
    without_reason_count: absences.filter((absence) => isWithoutReasonCode(absence.reason_code)).length,
    frequent_absence: absences.length >= 3,
    last_absence: absences[0] || null,
    last_comment: lastComment,
    recent_absences: absences.slice(0, 10),
  };
}

export async function getClassAbsenceStats(classId, { days = 30 } = {}) {
  const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
  const from = daysAgoDateTime(safeDays);
  const [rows] = await usr.query(
    `SELECT
        CAST(student_id AS CHAR) AS student_id,
        COUNT(*) AS absence_count,
        SUM(attention_status = 'needs_attention') AS needs_attention_count,
        SUM(reason_code = '${WITHOUT_REASON_CODE}') AS without_reason_count,
        MAX(starts_at) AS last_starts_at
       FROM attendance.absence_periods
      WHERE class_id = ?
        AND deleted_at IS NULL
        AND COALESCE(ends_at, ?) >= ?
      GROUP BY student_id`,
    [classId, FAR_FUTURE, from],
  );

  return new Map(rows.map((row) => [String(row.student_id), {
    absence_count: Number(row.absence_count || 0),
    needs_attention_count: Number(row.needs_attention_count || 0),
    without_reason_count: Number(row.without_reason_count || 0),
    frequent_absence: Number(row.absence_count || 0) >= 3,
    last_starts_at: row.last_starts_at,
  }]));
}

export async function getMonthlyAttendanceAnalytics({ month, classId, risk, reason, q, sort } = {}) {
  const selectedMonth = normalizeAnalyticsMonth(month);
  const range = buildMonthRange(selectedMonth);
  const classes = await getClasses();
  const selectedClass = normalizeAnalyticsClass(classes, classId);
  const classFilter = selectedClass.id === 'all' ? null : selectedClass.id;
  const [students, periods, scheduleRows, publishedSchoolDays, activeWeekdays, arrivals, todayAbsences] = await Promise.all([
    getMonthlyAnalyticsStudents(classFilter),
    getMonthlyAnalyticsPeriods(range, classFilter),
    getPublishedScheduleRows(range, classFilter),
    getPublishedScheduleDays(range),
    getActiveScheduleWeekdays(),
    getMonthlyFirstPresenceArrivals(range, classFilter),
    getTodayAbsenceOverview({ classId: classFilter }),
  ]);

  const analytics = buildMonthlyAnalytics({
    range,
    classes,
    selectedClass,
    students,
    periods,
  });
  analytics.learning = buildLearningAnalytics({
    range,
    students,
    periods,
    scheduleRows,
    publishedSchoolDays,
    activeWeekdays,
  });
  analytics.lateness = buildLateAnalytics({
    range,
    students,
    arrivals,
    scheduleRows,
    publishedSchoolDays,
    activeWeekdays,
  });
  analytics.today_absences = todayAbsences;
  analytics.has_activity = Boolean(
    analytics.has_data
    || analytics.learning?.has_data
    || analytics.lateness?.has_activity
    || analytics.today_absences?.has_absences
  );
  const worklist = buildRiskWorklist({
    range,
    periods,
    learning: analytics.learning,
    lateness: analytics.lateness,
    filters: { risk, reason, q, sort },
  });
  analytics.risk = worklist;
  analytics.risk_students = worklist.items;
  analytics.risk_students_total = worklist.total_count;
  analytics.risk_students_filtered = worklist.filtered_count;
  analytics.risk_filter_options = worklist.filter_options;
  analytics.risk_sort_options = worklist.sort_options;
  analytics.risk_reason_options = worklist.reason_options;
  analytics.risk_filters = worklist.filters;
  return analytics;
}

export async function getStudentLearningAnalytics(studentId, { month } = {}) {
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ValidationError('Ученик не найден', 404);
  }

  const selectedMonth = normalizeAnalyticsMonth(month);
  const range = buildMonthRange(selectedMonth);
  const [classStudents, periods, scheduleRows, publishedSchoolDays, activeWeekdays] = await Promise.all([
    getMonthlyAnalyticsStudents(student.classId),
    getMonthlyAnalyticsPeriods(range, student.classId, student.id),
    getPublishedScheduleRows(range, student.classId),
    getPublishedScheduleDays(range),
    getActiveScheduleWeekdays(),
  ]);
  const students = classStudents.filter((item) => String(item.student_id) === String(student.id));
  const learning = buildLearningAnalytics({
    range,
    students,
    periods,
    scheduleRows,
    publishedSchoolDays,
    activeWeekdays,
    includeLessons: true,
  });
  const selectedStudent = students[0] || {
    student_id: String(student.id),
    student_name: student.name,
    class_id: String(student.classId),
    class_name: '',
  };

  return {
    month: range.month,
    month_label: range.month_label,
    student_id: selectedStudent.student_id,
    student_name: selectedStudent.student_name,
    class_id: selectedStudent.class_id,
    class_name: selectedStudent.class_name,
    period: {
      from: range.start_date,
      to: range.end_date,
      days_count: range.days_count,
    },
    ...learning,
  };
}

export async function getStudentLatenessAnalytics(studentId, { month } = {}) {
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ValidationError('Ученик не найден', 404);
  }

  const selectedMonth = normalizeAnalyticsMonth(month);
  const range = buildMonthRange(selectedMonth);
  const [classStudents, scheduleRows, publishedSchoolDays, activeWeekdays, arrivals] = await Promise.all([
    getMonthlyAnalyticsStudents(student.classId),
    getPublishedScheduleRows(range, student.classId),
    getPublishedScheduleDays(range),
    getActiveScheduleWeekdays(),
    getMonthlyFirstPresenceArrivals(range, student.classId, student.id),
  ]);
  const students = classStudents.filter((item) => String(item.student_id) === String(student.id));

  return buildLateAnalytics({
    range,
    students,
    arrivals,
    scheduleRows,
    publishedSchoolDays,
    activeWeekdays,
    includeEvents: true,
  });
}

export async function getStudentMonthlyAnalytics(studentId, { month } = {}) {
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ValidationError('Ученик не найден', 404);
  }

  const selectedMonth = normalizeAnalyticsMonth(month);
  const range = buildMonthRange(selectedMonth);
  const [periods, learning, lateness, reasons, classes] = await Promise.all([
    listAbsencePeriods({
      studentId,
      from: range.start_at,
      to: range.end_at,
      limit: 500,
    }),
    getStudentLearningAnalytics(studentId, { month: selectedMonth }),
    getStudentLatenessAnalytics(studentId, { month: selectedMonth }),
    getAbsenceReasons(),
    getClasses(),
  ]);
  const classItem = classes.find((item) => String(item.id) === String(student.classId));
  const absenceDayKeys = new Set();
  let withoutReason = 0;
  let needsAttention = 0;
  let needsClarification = 0;

  for (const period of periods) {
    for (const day of expandDateRangeWithinMonth(period.starts_at, period.ends_at || period.starts_at, range)) {
      absenceDayKeys.add(`${period.student_id}|${day}`);
    }
    if (period.is_without_reason) withoutReason += 1;
    if (period.needs_attention) needsAttention += 1;
    if (period.confirmation_status === 'needs_clarification') needsClarification += 1;
  }

  return {
    month: range.month,
    month_label: range.month_label,
    period: {
      from: range.start_date,
      to: range.end_date,
      days_count: range.days_count,
    },
    student: {
      id: String(student.id),
      name: student.name || '',
      class_id: String(student.classId || ''),
      class_name: classItem?.name || '',
      href: `/attendance?class=${encodeURIComponent(student.classId || '')}&student=${encodeURIComponent(student.id)}&analyticsMonth=${encodeURIComponent(range.month)}#learning-analytics`,
    },
    kpi: {
      periods: periods.length,
      absence_days: absenceDayKeys.size,
      without_reason: withoutReason,
      needs_attention: needsAttention,
      needs_clarification: needsClarification,
      missed_lessons: Number(learning.missed_lessons_total || 0),
      data_gaps: Number(learning.data_gaps_total || 0),
      late_days: Number(lateness.late_days_total || 0),
      late_minutes: Number(lateness.total_late_minutes || 0),
      late_missed_lessons: Number(lateness.missed_lessons_total || 0),
    },
    periods,
    learning,
    lateness,
    reason_options: reasons.map((item) => ({
      code: item.code,
      name: item.name,
      default_confirmation_status: item.defaultConfirmationStatus,
      requires_attention: item.requiresAttention,
    })),
  };
}

export async function getSchoolDayBounds(date) {
  const selectedDate = normalizeDateOnly(date || todayDate());
  const weekday = weekdayFromDate(selectedDate);
  const [rows] = await usr.query(
    `SELECT
        TIME_FORMAT(MIN(start_time), '%H:%i:%s') AS start_time,
        TIME_FORMAT(MAX(end_time), '%H:%i:%s') AS end_time
       FROM school_local.schedule_time_slots
      WHERE is_active = 1
        AND day_of_week = ?`,
    [weekday],
  );

  const row = rows[0] || {};
  const startTime = normalizeClockTime(row.start_time) || SCHOOL_DAY_FALLBACK_START;
  let endTime = normalizeClockTime(row.end_time) || SCHOOL_DAY_FALLBACK_END;
  if (compareClockTimes(endTime, SCHOOL_DAY_FALLBACK_END) > 0) {
    endTime = SCHOOL_DAY_FALLBACK_END;
  }
  if (compareClockTimes(startTime, endTime) >= 0) {
    return schoolDayBoundsPayload(selectedDate, weekday, SCHOOL_DAY_FALLBACK_START, SCHOOL_DAY_FALLBACK_END, false);
  }

  return schoolDayBoundsPayload(selectedDate, weekday, startTime, endTime, Boolean(row.start_time && row.end_time));
}

async function getMonthlyAnalyticsStudents(classId) {
  const where = [
    'u.type = 1',
    'u.status = 1',
    'u.kaf > 0',
    'k.type = 1',
  ];
  const params = [];
  if (classId) {
    where.push('u.kaf = ?');
    params.push(classId);
  }

  const [rows] = await usr.query(
    `SELECT
        CAST(u.id AS CHAR) AS student_id,
        COALESCE(NULLIF(u.display_name_custom, ''), NULLIF(u.nickname, ''), NULLIF(u.msgnickname, ''), u.name) AS student_name,
        CAST(u.kaf AS CHAR) AS class_id,
        k.name AS class_name
       FROM sso.users u
       JOIN sso.kaf_name k ON k.id = u.kaf
      WHERE ${where.join(' AND ')}
      ORDER BY k.id, student_name`,
    params,
  );
  return rows;
}

async function getMonthlyAnalyticsPeriods(range, classId, studentId = null) {
  const where = [
    'p.deleted_at IS NULL',
    'p.starts_at <= ?',
    'COALESCE(p.ends_at, p.starts_at) >= ?',
    'u.type = 1',
    'u.status = 1',
    'k.type = 1',
  ];
  const params = [range.start_at, range.end_at, range.end_at, range.start_at];
  if (classId) {
    where.push('p.class_id = ?');
    params.push(classId);
  }
  if (studentId) {
    where.push('p.student_id = ?');
    params.push(studentId);
  }

  const [rows] = await usr.query(
    `SELECT
        CAST(p.id AS CHAR) AS id,
        CAST(p.student_id AS CHAR) AS student_id,
        CAST(p.class_id AS CHAR) AS class_id,
        COALESCE(NULLIF(u.display_name_custom, ''), NULLIF(u.nickname, ''), NULLIF(u.msgnickname, ''), u.name) AS student_name,
        k.name AS class_name,
        DATE_FORMAT(p.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
        DATE_FORMAT(p.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
        ROUND(GREATEST(0, TIMESTAMPDIFF(MINUTE,
          GREATEST(p.starts_at, ?),
          LEAST(COALESCE(p.ends_at, TIMESTAMP(DATE(p.starts_at), '23:59:59')), ?)
        ) / 60), 4) AS period_hours,
        p.reason_code,
        r.name AS reason_name,
        r.is_excused,
        p.comment,
        p.source,
        p.confirmation_status,
        p.attention_status,
        DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(p.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
       FROM attendance.absence_periods p
       JOIN attendance.absence_reasons r ON r.code = p.reason_code
       JOIN sso.users u ON u.id = p.student_id
       JOIN sso.kaf_name k ON k.id = p.class_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.starts_at, p.id`,
    params,
  );
  return rows;
}

async function getMonthlyFirstPresenceArrivals(range, classId, studentId = null) {
  const where = [
    'e.event_type = ?',
    'e.cancelled_at IS NULL',
    'e.attendance_date BETWEEN ? AND ?',
    'u.type = 1',
    'u.status = 1',
    'k.type = 1',
  ];
  const params = [PRESENCE_EVENT_TYPES.ARRIVAL, range.start_date, range.end_date];
  if (classId) {
    where.push('e.class_id = ?');
    params.push(classId);
  }
  if (studentId) {
    where.push('e.student_id = ?');
    params.push(studentId);
  }

  const [rows] = await usr.query(
    `SELECT *
       FROM (
         SELECT
           CAST(e.id AS CHAR) AS id,
           CAST(e.student_id AS CHAR) AS student_id,
           CAST(e.class_id AS CHAR) AS class_id,
           '${PRESENCE_EVENT_TYPES.ARRIVAL}' AS event_type,
           DATE_FORMAT(e.attendance_date, '%Y-%m-%d') AS attendance_date,
           DATE_FORMAT(e.occurred_at, '%Y-%m-%d %H:%i:%s') AS arrival_at,
           DATE_FORMAT(e.occurred_at, '%Y-%m-%d %H:%i:%s') AS occurred_at,
           COALESCE(NULLIF(u.display_name_custom, ''), NULLIF(u.nickname, ''), NULLIF(u.msgnickname, ''), u.name) AS student_name,
           k.name AS class_name,
           ROW_NUMBER() OVER (
             PARTITION BY e.student_id, e.attendance_date
             ORDER BY e.occurred_at, e.id
           ) AS row_num
          FROM attendance.presence_events e
          JOIN sso.users u ON u.id = e.student_id
          JOIN sso.kaf_name k ON k.id = e.class_id
         WHERE ${where.join(' AND ')}
       ) first_arrivals
      WHERE row_num = 1
      ORDER BY attendance_date, arrival_at, student_name`,
    params,
  );
  return rows;
}

async function getPublishedScheduleRows(range, classId) {
  const lessonDateSql = 'DATE(DATE_ADD(w.week_start, INTERVAL (ts.day_of_week - 1) DAY))';
  const where = [
    `${lessonDateSql} BETWEEN ? AND ?`,
  ];
  const params = [range.start_date, range.end_date];
  if (classId) {
    where.push('(e.class_id = ? OR su.kaf = ?)');
    params.push(classId, classId);
  }

  const [rows] = await usr.query(
    `SELECT
        CAST(e.id AS CHAR) AS entry_id,
        CAST(w.id AS CHAR) AS week_id,
        CAST(v.id AS CHAR) AS week_version_id,
        DATE_FORMAT(w.week_start, '%Y-%m-%d') AS week_start,
        DATE_FORMAT(${lessonDateSql}, '%Y-%m-%d') AS lesson_date,
        ts.day_of_week,
        CAST(ts.id AS CHAR) AS slot_id,
        ts.slot_number,
        TIME_FORMAT(ts.start_time, '%H:%i:%s') AS start_time,
        TIME_FORMAT(ts.end_time, '%H:%i:%s') AS end_time,
        CAST(e.class_id AS CHAR) AS class_id,
        k.name AS class_name,
        CAST(e.student_id AS CHAR) AS student_id,
        CAST(e.subject_id AS CHAR) AS subject_id,
        COALESCE(NULLIF(e.custom_subject_name, ''), s.name, '') AS subject_name,
        st.name AS subject_type,
        CAST(e.teacher_id AS CHAR) AS teacher_id,
        COALESCE(NULLIF(t.display_name_custom, ''), NULLIF(t.nickname, ''), NULLIF(t.msgnickname, ''), t.name) AS teacher_name,
        CAST(e.room_id AS CHAR) AS room_id,
        r.name AS room_name,
        e.activity_type,
        COALESCE(at.slot_part, 'FULL') AS slot_part,
        e.is_paid,
        CAST(e.lesson_type_id AS CHAR) AS lesson_type_id
       FROM school_local.schedule_entries e
       JOIN school_local.schedule_week_versions v
         ON v.id = e.week_version_id
        AND v.state = 'published'
       JOIN school_local.schedule_weeks w ON w.id = v.week_id
       JOIN school_local.schedule_publications p
         ON p.week_id = v.week_id
        AND p.published_version_id = v.id
        AND p.is_current = 1
       JOIN school_local.schedule_time_slots ts
         ON ts.id = e.slot_id
        AND ts.is_active = 1
       LEFT JOIN sso.users su ON su.id = e.student_id
       LEFT JOIN sso.kaf_name k ON k.id = e.class_id
       LEFT JOIN school_local.info_subjects s ON s.id = e.subject_id
       LEFT JOIN school_local.info_subjects_types st ON st.id = s.type
       LEFT JOIN sso.users t ON t.id = e.teacher_id
       LEFT JOIN school_local.info_rooms r ON r.id = e.room_id
       LEFT JOIN school_local.activity_types at ON at.code = e.activity_type
      WHERE ${where.join(' AND ')}
      ORDER BY lesson_date, ts.slot_number, e.class_id, e.student_id, subject_name`,
    params,
  );
  return rows;
}

async function getPublishedScheduleDays(range) {
  const lessonDateSql = 'DATE(DATE_ADD(w.week_start, INTERVAL (ts.day_of_week - 1) DAY))';
  const [rows] = await usr.query(
    `SELECT DISTINCT DATE_FORMAT(${lessonDateSql}, '%Y-%m-%d') AS date
       FROM school_local.schedule_publications p
       JOIN school_local.schedule_week_versions v
         ON v.id = p.published_version_id
        AND v.week_id = p.week_id
        AND v.state = 'published'
       JOIN school_local.schedule_weeks w ON w.id = p.week_id
       JOIN school_local.schedule_time_slots ts ON ts.is_active = 1
      WHERE p.is_current = 1
        AND ${lessonDateSql} BETWEEN ? AND ?
      ORDER BY date`,
    [range.start_date, range.end_date],
  );
  return rows.map((row) => row.date).filter(Boolean);
}

async function getActiveScheduleWeekdays() {
  const [rows] = await usr.query(
    `SELECT DISTINCT day_of_week
       FROM school_local.schedule_time_slots
      WHERE is_active = 1
      ORDER BY day_of_week`,
  );
  return rows.map((row) => Number(row.day_of_week)).filter((day) => day >= 1 && day <= 7);
}

function buildMonthlyAnalytics({ range, classes, selectedClass, students, periods }) {
  const studentById = new Map(students.map((student) => [String(student.student_id), student]));
  const studentsByClass = new Map();
  const dailyBuckets = new Map(range.days.map((day) => [day, createDailyBucket(day)]));
  const reasonBuckets = new Map();
  const classBuckets = new Map();
  const riskBuckets = new Map();
  const absentStudents = new Set();
  const absenceDayKeys = new Set();
  const nowSql = sqlNow();

  const visibleClasses = selectedClass.id === 'all'
    ? classes
    : classes.filter((item) => String(item.id) === String(selectedClass.id));
  for (const classItem of visibleClasses) {
    classBuckets.set(String(classItem.id), createClassBucket(classItem));
  }

  for (const student of students) {
    const classId = String(student.class_id);
    studentsByClass.set(classId, Number(studentsByClass.get(classId) || 0) + 1);
    ensureClassBucket(classBuckets, {
      class_id: classId,
      class_name: student.class_name,
    }).students_total += 1;
  }

  let withoutReasonPeriods = 0;
  let needsAttentionPeriods = 0;
  let needsClarificationPeriods = 0;

  for (const period of periods) {
    const periodId = String(period.id);
    const studentId = String(period.student_id);
    const classId = String(period.class_id);
    const days = expandDateRangeWithinMonth(period.starts_at, period.ends_at || period.starts_at, range);
    if (!days.length) continue;
    const periodHours = Number.isFinite(Number(period.period_hours))
      ? Number(period.period_hours)
      : hoursWithinRange(period.starts_at, period.ends_at, range);

    const isWithoutReason = isWithoutReasonCode(period.reason_code);
    const needsAttention = period.attention_status === 'needs_attention';
    const needsClarification = period.confirmation_status === 'needs_clarification';
    const isPlanned = String(period.starts_at || '') > nowSql;
    if (isWithoutReason) withoutReasonPeriods += 1;
    if (needsAttention) needsAttentionPeriods += 1;
    if (needsClarification) needsClarificationPeriods += 1;

    absentStudents.add(studentId);
    const reasonBucket = ensureReasonBucket(reasonBuckets, period);
    const classBucket = ensureClassBucket(classBuckets, period);
    const riskBucket = ensureRiskBucket(riskBuckets, period, studentById);

    reasonBucket.periods += 1;
    reasonBucket.students.add(studentId);
    classBucket.periods += 1;
    classBucket.periodIds.add(periodId);
    classBucket.absentStudents.add(studentId);
    classBucket.absenceHours += periodHours;
    riskBucket.periods += 1;

    if (!riskBucket.last_starts_at || String(period.starts_at) >= riskBucket.last_starts_at) {
      riskBucket.last_starts_at = String(period.starts_at || '');
      riskBucket.last_ends_at = String(period.ends_at || '');
      riskBucket.last_reason = period.reason_name || period.reason_code || '';
      riskBucket.last_comment = period.comment || '';
    }

    for (const day of days) {
      const dayKey = `${studentId}|${day}`;
      absenceDayKeys.add(dayKey);
      reasonBucket.absenceDays.add(dayKey);
      classBucket.absenceDays.add(dayKey);
      riskBucket.absenceDays.add(dayKey);

      const dailyBucket = dailyBuckets.get(day);
      if (dailyBucket) {
        dailyBucket.absentStudents.add(studentId);
        dailyBucket.periodIds.add(periodId);
        dailyBucket.absenceDays.add(dayKey);
        const dayHours = hoursWithinDay(period, day);
        dailyBucket.absenceHours += dayHours;
        const dailyReasonBucket = ensureDailyReasonBucket(dailyBucket.reasonBuckets, period);
        dailyReasonBucket.absenceDays.add(dayKey);
        dailyReasonBucket.periodIds.add(periodId);
        dailyReasonBucket.students.add(studentId);
        dailyReasonBucket.absenceHours += dayHours;
      }

      if (isWithoutReason) {
        classBucket.withoutReason.add(dayKey);
        riskBucket.withoutReason.add(dayKey);
        if (dailyBucket) dailyBucket.withoutReason.add(dayKey);
      }
      if (needsAttention) {
        classBucket.needsAttention.add(dayKey);
        riskBucket.needsAttention.add(dayKey);
        if (dailyBucket) dailyBucket.needsAttention.add(dayKey);
      }
      if (isPlanned && dailyBucket) {
        dailyBucket.plannedAbsences.add(dayKey);
      }
    }
  }

  const totalAbsenceDays = absenceDayKeys.size;
  const dailyRows = Array.from(dailyBuckets.values()).map((bucket) => {
    const reasonSegments = dailyReasonSegments(bucket);
    return {
      date: bucket.date,
      date_label: formatDateLabel(bucket.date),
      day_label: bucket.date.slice(8, 10),
      absent_students: bucket.absentStudents.size,
      absence_periods: bucket.periodIds.size,
      absence_days: bucket.absenceDays.size,
      absence_hours: round1(bucket.absenceHours),
      absence_hours_label: formatHoursShort(bucket.absenceHours),
      without_reason: bucket.withoutReason.size,
      needs_attention: bucket.needsAttention.size,
      planned_absences: bucket.plannedAbsences.size,
      reason_segments: reasonSegments,
      reason_summary: dailyReasonSummary(reasonSegments),
      top_reason_code: reasonSegments[0]?.code || '',
      top_reason_name: reasonSegments[0]?.name || '',
      top_reason_color: reasonSegments[0]?.color || REASON_BAR_COLORS.default,
    };
  });
  markDailySpikes(dailyRows);
  const maxDailyDays = Math.max(0, ...dailyRows.map((row) => row.absence_days));
  for (const row of dailyRows) {
    row.bar_width = maxDailyDays ? percentOf(row.absence_days, maxDailyDays) : 0;
    row.heat_style = dailyHeatStyle(row, maxDailyDays);
    row.heat_title = richDailyHeatTitle(row);
  }
  const dailyCalendar = buildDailyCalendar(range, dailyRows);
  const dailyActiveRows = dailyRows.filter((row) => (
    row.absence_days > 0 ||
    row.absence_periods > 0 ||
    row.without_reason > 0 ||
    row.needs_attention > 0 ||
    row.planned_absences > 0 ||
    row.has_spike
  ));

  const reasonRows = Array.from(reasonBuckets.values())
    .map((bucket) => ({
      code: bucket.code,
      name: bucket.name,
      periods: bucket.periods,
      students: bucket.students.size,
      absence_days: bucket.absenceDays.size,
      percent: percentOf(bucket.absenceDays.size, totalAbsenceDays),
      bar_width: percentOf(bucket.absenceDays.size, totalAbsenceDays),
      bar_color: reasonBarColor(bucket.code),
    }))
    .sort((a, b) => b.absence_days - a.absence_days || a.name.localeCompare(b.name, 'ru'));

  const classRowsAll = Array.from(classBuckets.values())
    .map((bucket) => ({
      class_id: bucket.class_id,
      class_name: bucket.class_name,
      students_total: bucket.students_total || Number(studentsByClass.get(bucket.class_id) || 0),
      absent_students: bucket.absentStudents.size,
      periods: bucket.periods,
      absence_days: bucket.absenceDays.size,
      absence_hours: round1(bucket.absenceHours),
      absence_hours_label: formatHoursShort(bucket.absenceHours),
      without_reason: bucket.withoutReason.size,
      needs_attention: bucket.needsAttention.size,
    }))
    .filter((row) => selectedClass.id !== 'all' || row.students_total > 0 || row.periods > 0);
  const maxClassDays = Math.max(0, ...classRowsAll.map((row) => row.absence_days));
  for (const row of classRowsAll) {
    row.bar_width = maxClassDays ? percentOf(row.absence_days, maxClassDays) : 0;
  }
  classRowsAll.sort((a, b) => compareClassNames(a.class_name, b.class_name));
  const classRows = selectedClass.id === 'all'
    ? classRowsAll.filter((row) => row.periods > 0 || row.absence_days > 0 || row.absence_hours > 0 || row.without_reason > 0 || row.needs_attention > 0)
    : classRowsAll;
  const classChart = buildClassDistributionChart(classRows);

  const riskStudents = Array.from(riskBuckets.values())
    .map((bucket) => ({
      student_id: bucket.student_id,
      student_name: bucket.student_name,
      class_name: bucket.class_name,
      periods: bucket.periods,
      absence_days: bucket.absenceDays.size,
      without_reason: bucket.withoutReason.size,
      needs_attention: bucket.needsAttention.size,
      last_reason: bucket.last_reason || '',
      last_comment: bucket.last_comment || '',
      last_comment_short: truncateText(bucket.last_comment || '', 120),
      has_long_comment: String(bucket.last_comment || '').length > 120,
      last_starts_at: bucket.last_starts_at || '',
      last_ends_at: bucket.last_ends_at || '',
      last_period_date: formatCompactPeriodDate(bucket.last_starts_at || '', bucket.last_ends_at || ''),
      last_period_time: formatCompactPeriodTime(bucket.last_starts_at || '', bucket.last_ends_at || ''),
      last_period_label: formatCompactPeriodLabel(bucket.last_starts_at || '', bucket.last_ends_at || ''),
    }))
    .sort((a, b) => (
      b.needs_attention - a.needs_attention ||
      b.without_reason - a.without_reason ||
      b.absence_days - a.absence_days ||
      b.periods - a.periods ||
      a.student_name.localeCompare(b.student_name, 'ru')
    ))
    .slice(0, 20);

  const qualityIssues = [];
  if (withoutReasonPeriods > 0) {
    qualityIssues.push({ code: 'without_reason', label: 'Записи без точной причины', value: withoutReasonPeriods });
  }
  if (needsClarificationPeriods > 0) {
    qualityIssues.push({ code: 'needs_clarification', label: 'Требуют уточнения', value: needsClarificationPeriods });
  }
  if (needsAttentionPeriods > 0) {
    qualityIssues.push({ code: 'needs_attention', label: 'Открытое внимание', value: needsAttentionPeriods });
  }

  const totalPeriods = periods.length;
  return {
    month: range.month,
    month_label: range.month_label,
    class_id: selectedClass.id,
    class_name: selectedClass.name,
    period: {
      from: range.start_date,
      to: range.end_date,
      days_count: range.days_count,
    },
    available_classes: [
      { id: 'all', name: 'Все классы', selected: selectedClass.id === 'all' },
      ...classes.map((item) => ({
        id: item.id,
        name: item.name,
        students_count: Number(item.students_count || 0),
        selected: String(item.id) === String(selectedClass.id),
      })),
    ],
    kpi: {
      students_total: students.length,
      students_with_absences: absentStudents.size,
      absence_periods: totalPeriods,
      absence_days: totalAbsenceDays,
      absence_hours: classChart.total_hours,
      absence_hours_label: classChart.total_hours_label,
      with_reason_percent: totalPeriods ? percentOf(totalPeriods - withoutReasonPeriods, totalPeriods) : 100,
      without_reason: withoutReasonPeriods,
      without_reason_days: countPeriodDays(periods, range, (period) => isWithoutReasonCode(period.reason_code)),
      needs_attention: needsAttentionPeriods,
      needs_clarification: needsClarificationPeriods,
    },
    daily: dailyRows,
    daily_active: dailyActiveRows,
    daily_calendar: dailyCalendar,
    daily_calendar_weekdays: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    hidden_zero_days: dailyRows.length - dailyActiveRows.length,
    reasons: reasonRows,
    classes: classRows,
    classes_all: classRowsAll,
    class_chart: classChart,
    hidden_zero_classes: classRowsAll.length - classRows.length,
    risk_students: riskStudents,
    quality: {
      without_reason: withoutReasonPeriods,
      needs_clarification: needsClarificationPeriods,
      needs_attention: needsAttentionPeriods,
      has_issues: qualityIssues.length > 0,
      issues: qualityIssues,
    },
    has_data: totalPeriods > 0,
  };
}

function normalizeAnalyticsClass(classes, classId) {
  const raw = String(classId || 'all').trim();
  if (raw && raw !== 'all') {
    const found = classes.find((item) => String(item.id) === raw);
    if (found) return { id: String(found.id), name: found.name };
  }
  return { id: 'all', name: 'Все классы' };
}

function buildClassDistributionChart(classRows) {
  const activeRows = classRows
    .filter((row) => row.absence_days > 0 || row.absence_hours > 0)
    .map((row) => ({
      ...row,
      chart_value: row.absence_days > 0 ? row.absence_days : row.absence_hours,
    }));

  const totalDays = activeRows.reduce((sum, row) => sum + Number(row.absence_days || 0), 0);
  const totalHoursRaw = activeRows.reduce((sum, row) => sum + Number(row.absence_hours || 0), 0);
  const totalValue = totalDays > 0 ? totalDays : totalHoursRaw;

  if (!activeRows.length || totalValue <= 0) {
    return {
      has_data: false,
      gradient: 'conic-gradient(#e5e7eb 0deg 360deg)',
      total_days: 0,
      total_hours: 0,
      total_hours_label: formatHoursShort(0),
      basis_label: 'ученик-дней',
      items: [],
    };
  }

  const sortedRows = activeRows.sort((a, b) => (
    b.chart_value - a.chart_value ||
    b.absence_days - a.absence_days ||
    compareClassNames(a.class_name, b.class_name)
  ));
  const visibleRows = sortedRows.slice(0, 8);
  const hiddenRows = sortedRows.slice(8);
  const chartRows = visibleRows.map((row) => ({ ...row }));
  if (hiddenRows.length) {
    chartRows.push({
      class_id: 'other',
      class_name: 'Остальные',
      students_total: hiddenRows.reduce((sum, row) => sum + Number(row.students_total || 0), 0),
      absent_students: hiddenRows.reduce((sum, row) => sum + Number(row.absent_students || 0), 0),
      periods: hiddenRows.reduce((sum, row) => sum + Number(row.periods || 0), 0),
      absence_days: hiddenRows.reduce((sum, row) => sum + Number(row.absence_days || 0), 0),
      absence_hours: round1(hiddenRows.reduce((sum, row) => sum + Number(row.absence_hours || 0), 0)),
      without_reason: hiddenRows.reduce((sum, row) => sum + Number(row.without_reason || 0), 0),
      needs_attention: hiddenRows.reduce((sum, row) => sum + Number(row.needs_attention || 0), 0),
      chart_value: hiddenRows.reduce((sum, row) => sum + Number(row.chart_value || 0), 0),
    });
  }

  let cursor = 0;
  const segments = [];
  const items = chartRows.map((row, index) => {
    const color = CLASS_CHART_COLORS[index % CLASS_CHART_COLORS.length];
    const nextCursor = index === chartRows.length - 1 ? 360 : cursor + (Number(row.chart_value || 0) / totalValue) * 360;
    segments.push(`${color} ${formatAngle(cursor)}deg ${formatAngle(nextCursor)}deg`);
    cursor = nextCursor;
    return {
      class_id: row.class_id,
      class_name: row.class_name,
      color,
      percent: percentOf(row.chart_value, totalValue),
      periods: row.periods,
      absence_days: row.absence_days,
      absence_hours: round1(row.absence_hours),
      absence_hours_label: formatHoursShort(row.absence_hours),
      absent_students: row.absent_students,
      students_total: row.students_total,
    };
  });

  return {
    has_data: true,
    gradient: `conic-gradient(${segments.join(', ')})`,
    total_days: totalDays,
    total_hours: round1(totalHoursRaw),
    total_hours_label: formatHoursShort(totalHoursRaw),
    basis_label: totalDays > 0 ? 'ученик-дней' : 'часов',
    items,
  };
}

function formatAngle(value) {
  return round1(value).toFixed(1).replace(/\.0$/, '');
}

function round1(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function formatHoursShort(value) {
  const rounded = round1(value);
  if (!rounded) return '0 ч.';
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace('.', ',');
  return `${text} ч.`;
}

function formatDateLabel(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(value || '');
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function hoursWithinDay(period, day) {
  return hoursWithinRange(period.starts_at, period.ends_at, {
    start_at: `${day} 00:00:00`,
    end_at: `${day} 23:59:59`,
  });
}

function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildDailyCalendar(range, dailyRows) {
  const firstDay = new Date(Date.UTC(Number(range.month.slice(0, 4)), Number(range.month.slice(5, 7)) - 1, 1)).getUTCDay();
  const leadingDays = (firstDay + 6) % 7;
  const slots = Array.from({ length: leadingDays }, (_, index) => ({
    is_empty: true,
    key: `leading-${index}`,
  }));

  for (const row of dailyRows) {
    slots.push({
      ...row,
      is_empty: false,
      key: row.date,
    });
  }

  const trailingDays = (7 - (slots.length % 7)) % 7;
  for (let index = 0; index < trailingDays; index += 1) {
    slots.push({
      is_empty: true,
      key: `trailing-${index}`,
    });
  }

  return slots;
}

function markDailySpikes(dailyRows) {
  for (let index = 0; index < dailyRows.length; index += 1) {
    const row = dailyRows[index];
    const previous = dailyRows[index - 1];
    const currentDays = Number(row.absence_days || 0);
    const previousDays = Number(previous?.absence_days || 0);
    const hasSpike = currentDays >= 3 && currentDays >= Math.max(3, previousDays * 2);
    row.has_spike = Boolean(previous && hasSpike);
    row.spike_label = row.has_spike
      ? `рост с ${previousDays} до ${currentDays} ученик-дн.`
      : '';
  }
}

function dailyReasonSegments(bucket) {
  const totalDays = bucket.absenceDays.size;
  return Array.from(bucket.reasonBuckets.values())
    .map((item) => {
      const absenceDays = item.absenceDays.size;
      const hoursLabel = formatHoursShort(item.absenceHours);
      const title = `${item.name}: ${absenceDays} дн., ${item.students.size} уч., ${item.periodIds.size} пер., ${hoursLabel}`;
      return {
        code: item.code,
        name: item.name,
        color: reasonBarColor(item.code),
        absence_days: absenceDays,
        absence_hours: round1(item.absenceHours),
        absence_hours_label: hoursLabel,
        periods: item.periodIds.size,
        students: item.students.size,
        width: percentOf(absenceDays, totalDays),
        title,
      };
    })
    .sort((a, b) => (
      b.absence_days - a.absence_days ||
      b.absence_hours - a.absence_hours ||
      a.name.localeCompare(b.name, 'ru')
    ));
}

function dailyReasonSummary(segments) {
  if (!segments.length) return '';
  const [top, ...rest] = segments;
  const suffix = rest.length ? ` +${rest.length}` : '';
  return `${top.name} · ${top.absence_days} дн.${suffix}`;
}

function dailyHeatStyle(row, maxDailyDays) {
  if (Number(row.absence_days || 0) <= 0) {
    return 'background-color:#f8fafc;border-color:#e2e8f0;color:#94a3b8;';
  }

  const ratio = maxDailyDays ? Number(row.absence_days || 0) / maxDailyDays : 0;
  if (Number(row.needs_attention || 0) > 0) {
    return paletteStyle(REASON_CELL_PALETTES.attention, ratio, maxDailyDays);
  }
  if (Number(row.without_reason || 0) > 0) {
    return paletteStyle(REASON_CELL_PALETTES[WITHOUT_REASON_CODE], ratio, maxDailyDays);
  }

  const palette = REASON_CELL_PALETTES[row.top_reason_code] || REASON_CELL_PALETTES.default;
  return paletteStyle(palette, ratio, maxDailyDays);
}

function paletteStyle(palette, ratio, maxDailyDays) {
  const useStrong = maxDailyDays > 1 && ratio >= 0.67;
  const background = useStrong ? palette.strongBg : palette.bg;
  const color = useStrong ? palette.strongText : palette.text;
  return `background-color:${background};border-color:${palette.border};color:${color};`;
}

function reasonBarColor(code) {
  return REASON_BAR_COLORS[code] || REASON_BAR_COLORS.default;
}

function richDailyHeatTitle(row) {
  const parts = [
    row.date_label || row.date,
    `ученик-дней: ${Number(row.absence_days || 0)}`,
    `учеников: ${Number(row.absent_students || 0)}`,
    `периодов: ${Number(row.absence_periods || 0)}`,
    `часов: ${row.absence_hours_label || formatHoursShort(row.absence_hours)}`,
  ];
  for (const reason of row.reason_segments || []) {
    parts.push(`${reason.name}: ${reason.absence_days} дн., ${reason.students} уч., ${reason.periods} пер., ${reason.absence_hours_label}`);
  }
  if (Number(row.planned_absences || 0) > 0) parts.push(`запланировано: ${Number(row.planned_absences || 0)}`);
  if (Number(row.without_reason || 0) > 0) parts.push(`без причины: ${Number(row.without_reason || 0)}`);
  if (Number(row.needs_attention || 0) > 0) parts.push(`внимание: ${Number(row.needs_attention || 0)}`);
  if (row.has_spike) parts.push(`резкий рост: ${row.spike_label}`);
  return parts.join('\n');
}

function dailyHeatTitle(row) {
  const parts = [
    row.date_label || formatDateLabel(row.date),
    `ученик-дней: ${Number(row.absence_days || 0)}`,
    `учеников: ${Number(row.absent_students || 0)}`,
    `периодов: ${Number(row.absence_periods || 0)}`,
  ];
  if (Number(row.without_reason || 0) > 0) parts.push(`без причины: ${Number(row.without_reason || 0)}`);
  if (Number(row.needs_attention || 0) > 0) parts.push(`внимание: ${Number(row.needs_attention || 0)}`);
  return parts.join(' · ');
}

function formatCompactPeriodLabel(startsAt, endsAt) {
  const date = formatCompactPeriodDate(startsAt, endsAt);
  const time = formatCompactPeriodTime(startsAt, endsAt);
  return [date, time].filter(Boolean).join(' ');
}

function formatCompactPeriodDate(startsAt, endsAt) {
  const start = dateTimeParts(startsAt);
  if (!start) return '';
  const end = dateTimeParts(endsAt);
  if (!end || start.date === end.date) return start.dateLabel;
  return `${start.dateLabel}-${end.dateLabel}`;
}

function formatCompactPeriodTime(startsAt, endsAt) {
  const start = dateTimeParts(startsAt);
  if (!start) return '';
  const end = dateTimeParts(endsAt);
  if (!end) return `с ${start.time}`;
  return `${start.time}-${end.time}`;
}

function dateTimeParts(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return {
    year,
    date: `${year}-${month}-${day}`,
    shortDate: `${day}.${month}`,
    dateLabel: `${day}.${month}.${year}`,
    time: `${hour}:${minute}`,
  };
}

function parseSqlDateTimeMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second = '0'] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function createDailyBucket(date) {
  return {
    date,
    absentStudents: new Set(),
    periodIds: new Set(),
    absenceDays: new Set(),
    absenceHours: 0,
    withoutReason: new Set(),
    needsAttention: new Set(),
    plannedAbsences: new Set(),
    reasonBuckets: new Map(),
  };
}

function createClassBucket(item) {
  return {
    class_id: String(item.class_id ?? item.id ?? ''),
    class_name: item.class_name || item.name || '',
    students_total: 0,
    absentStudents: new Set(),
    periodIds: new Set(),
    absenceDays: new Set(),
    absenceHours: 0,
    withoutReason: new Set(),
    needsAttention: new Set(),
    periods: 0,
  };
}

function ensureClassBucket(map, item) {
  const classId = String(item.class_id ?? item.id ?? '');
  if (!map.has(classId)) {
    map.set(classId, createClassBucket(item));
  }
  return map.get(classId);
}

function ensureReasonBucket(map, period) {
  const code = period.reason_code || OTHER_REASON_CODE;
  if (!map.has(code)) {
    map.set(code, {
      code,
      name: period.reason_name || code,
      periods: 0,
      students: new Set(),
      absenceDays: new Set(),
    });
  }
  return map.get(code);
}

function ensureDailyReasonBucket(map, period) {
  const code = period.reason_code || OTHER_REASON_CODE;
  if (!map.has(code)) {
    map.set(code, {
      code,
      name: period.reason_name || code,
      absenceDays: new Set(),
      periodIds: new Set(),
      students: new Set(),
      absenceHours: 0,
    });
  }
  return map.get(code);
}

function ensureRiskBucket(map, period, studentById) {
  const studentId = String(period.student_id);
  if (!map.has(studentId)) {
    const student = studentById.get(studentId);
    map.set(studentId, {
      student_id: studentId,
      student_name: period.student_name || student?.student_name || '',
      class_name: period.class_name || student?.class_name || '',
      periods: 0,
      absenceDays: new Set(),
      withoutReason: new Set(),
      needsAttention: new Set(),
      last_reason: '',
      last_comment: '',
      last_starts_at: '',
      last_ends_at: '',
    });
  }
  return map.get(studentId);
}

function countPeriodDays(periods, range, predicate) {
  const days = new Set();
  for (const period of periods) {
    if (!predicate(period)) continue;
    for (const day of expandDateRangeWithinMonth(period.starts_at, period.ends_at || period.starts_at, range)) {
      days.add(`${period.student_id}|${day}`);
    }
  }
  return days.size;
}

async function validateAbsenceInput(input) {
  const studentId = toPositiveInt(input.studentId, 'studentId');
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ValidationError('Ученик не найден');
  }

  const classId = input.classId == null || input.classId === '' ? Number(student.classId) : toPositiveInt(input.classId, 'classId');
  if (String(classId) !== String(student.classId)) {
    throw new ValidationError('Класс не совпадает с классом ученика');
  }

  const startsAt = normalizeDateTime(input.startsAt, { field: 'startsAt', required: true });
  const endsAt = normalizeDateTime(input.endsAt, { field: 'endsAt', required: false });
  if (endsAt && endsAt <= startsAt) {
    throw new ValidationError('Окончание отсутствия должно быть позже начала');
  }

  const reasonCode = String(input.reasonCode || OTHER_REASON_CODE).trim();
  const reason = await getReasonOrFail(reasonCode);
  if (!reason.active) {
    throw new ValidationError('Причина отсутствия недоступна');
  }

  const comment = normalizeComment(input.comment);
  if (isOtherReasonCode(reasonCode) && !comment) {
    throw new ValidationError('Для причины «Другое» нужен комментарий');
  }

  const source = normalizeChoice(input.source, ['mentor', 'diary', 'import', 'system'], 'mentor', 'source');
  const confirmationStatus = normalizeChoice(
    input.confirmationStatus,
    ['confirmed', 'reported', 'needs_clarification', 'system_conflict'],
    reason.default_confirmation_status || 'confirmed',
    'confirmationStatus',
  );
  const defaultAttention = reason.requires_attention ? 'needs_attention' : 'normal';
  let attentionStatus = normalizeChoice(
    input.attentionStatus,
    ['normal', 'needs_attention', 'resolved'],
    defaultAttention,
    'attentionStatus',
  );
  let resolvedAt = attentionStatus === 'resolved'
    ? normalizeDateTime(input.resolvedAt, { field: 'resolvedAt', required: false }) || sqlNow()
    : null;
  let resolvedBy = attentionStatus === 'resolved' ? (input.resolvedBy || input.actorId || null) : null;

  let normalizedConfirmationStatus = confirmationStatus;
  if (isWithoutReasonCode(reasonCode)) {
    normalizedConfirmationStatus = 'needs_clarification';
    if (attentionStatus === 'normal') {
      attentionStatus = 'needs_attention';
      resolvedAt = null;
      resolvedBy = null;
    }
  }

  return {
    studentId,
    classId,
    startsAt,
    endsAt,
    reasonCode,
    comment,
    source,
    confirmationStatus: normalizedConfirmationStatus,
    attentionStatus,
    resolvedAt,
    resolvedBy,
    actorId: input.actorId ? Number(input.actorId) : null,
  };
}

async function getReasonOrFail(code) {
  const [rows] = await usr.query(
    `SELECT code, active, requires_attention, default_confirmation_status
       FROM attendance.absence_reasons
      WHERE code = ?
      LIMIT 1`,
    [code],
  );
  if (!rows[0]) {
    throw new ValidationError('Причина отсутствия не найдена');
  }
  return rows[0];
}

async function assertNoOverlap({ studentId, startsAt, endsAt, excludeId }) {
  const where = [
    'student_id = ?',
    'deleted_at IS NULL',
    'starts_at < ?',
    'COALESCE(ends_at, ?) > ?',
  ];
  const params = [studentId, endsAt || FAR_FUTURE, FAR_FUTURE, startsAt];

  if (excludeId) {
    where.push('id <> ?');
    params.push(excludeId);
  }

  const [rows] = await usr.query(
    `SELECT id
       FROM attendance.absence_periods
      WHERE ${where.join(' AND ')}
      LIMIT 1`,
    params,
  );

  if (rows[0]) {
    throw new ValidationError('У ученика уже есть отметка на пересекающийся период');
  }
}

function absenceSelectSql() {
  return `
    SELECT
      CAST(p.id AS CHAR) AS id,
      CAST(p.student_id AS CHAR) AS student_id,
      CAST(p.class_id AS CHAR) AS class_id,
      COALESCE(NULLIF(u.display_name_custom, ''), NULLIF(u.nickname, ''), NULLIF(u.msgnickname, ''), u.name) AS student_name,
      k.name AS class_name,
      DATE_FORMAT(p.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
      DATE_FORMAT(p.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
      p.reason_code,
      r.name AS reason_name,
      r.is_excused,
      r.requires_attention,
      r.default_confirmation_status,
      p.source,
      p.confirmation_status,
      p.attention_status,
      DATE_FORMAT(p.resolved_at, '%Y-%m-%d %H:%i:%s') AS resolved_at,
      CAST(p.resolved_by AS CHAR) AS resolved_by,
      p.comment,
      CAST(p.created_by AS CHAR) AS created_by,
      CAST(p.updated_by AS CHAR) AS updated_by,
      DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(p.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
    FROM attendance.absence_periods p
    JOIN attendance.absence_reasons r ON r.code = p.reason_code
    JOIN sso.users u ON u.id = p.student_id
    JOIN sso.kaf_name k ON k.id = p.class_id
  `;
}

function mapAbsencePeriod(row) {
  const startsAt = row.starts_at || '';
  const endsAt = row.ends_at || '';
  return {
    id: row.id,
    student_id: row.student_id,
    class_id: row.class_id,
    student_name: row.student_name || '',
    class_name: row.class_name || '',
    starts_at: startsAt,
    ends_at: endsAt,
    starts_at_input: toDateTimeLocal(startsAt),
    ends_at_input: toDateTimeLocal(endsAt),
    period_label: formatPeriodLabel(startsAt, endsAt),
    reason_code: row.reason_code,
    reason_name: row.reason_name,
    is_without_reason: isWithoutReasonCode(row.reason_code),
    is_excused: Boolean(row.is_excused),
    requires_attention: Boolean(row.requires_attention),
    default_confirmation_status: row.default_confirmation_status || 'confirmed',
    source: row.source || 'mentor',
    confirmation_status: row.confirmation_status || 'confirmed',
    attention_status: row.attention_status || 'normal',
    attention_label: attentionLabel(row.attention_status),
    confirmation_label: confirmationLabel(row.confirmation_status),
    needs_attention: row.attention_status === 'needs_attention',
    is_resolved: row.attention_status === 'resolved',
    resolved_at: row.resolved_at || '',
    resolved_by: row.resolved_by,
    comment: row.comment || '',
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',

    childId: row.student_id,
    classId: row.class_id,
    from: toDateTimeLocal(startsAt),
    to: toDateTimeLocal(endsAt),
    reason: row.reason_code,
    createdAt: row.created_at || '',
  };
}

function ensureTodayClassBucket(map, absence, studentsByClass) {
  const classId = String(absence.class_id || '');
  if (!map.has(classId)) {
    map.set(classId, {
      class_id: classId,
      class_name: absence.class_name || '',
      students_total: Number(studentsByClass.get(classId) || 0),
      studentBuckets: new Map(),
    });
  }
  return map.get(classId);
}

function buildTodayStudentRow(studentBucket, date, nowSql) {
  const periods = [...studentBucket.periods].sort((left, right) => compareTodayPeriods(left, right, nowSql));
  const selected = periods[0];
  const status = todayPeriodStatus(selected, nowSql);
  const extraPeriods = Math.max(0, periods.length - 1);
  const withoutReason = periods.some((period) => isWithoutReasonCode(period.reason_code));
  const needsAttention = periods.some((period) => period.attention_status === 'needs_attention');

  return {
    student_id: selected.student_id,
    student_name: selected.student_name || studentBucket.student_name || '',
    class_id: selected.class_id,
    class_name: selected.class_name,
    reason_name: selected.reason_name,
    reason_code: selected.reason_code,
    period_label: selected.period_label,
    today_period_label: formatTodayAbsencePeriodLabel(selected.starts_at, selected.ends_at, date),
    status_label: status.label,
    status_rank: status.rank,
    is_now: status.code === 'now',
    is_future_today: status.code === 'future',
    is_completed_today: status.code === 'completed',
    without_reason: withoutReason,
    needs_attention: needsAttention,
    periods_count: periods.length,
    period_count_label: extraPeriods ? `+${extraPeriods}` : '',
    href: attendanceHref({ classId: selected.class_id, studentId: selected.student_id, date }),
    row_class: needsAttention
      ? 'border-red-200 bg-red-50'
      : withoutReason
        ? 'border-amber-200 bg-amber-50'
        : 'border-gray-200 bg-white',
    status_class: status.className,
    reason_class: needsAttention
      ? 'bg-red-100 text-red-800'
      : withoutReason
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-700',
  };
}

function compareTodayStudentRows(left, right) {
  return (
    left.status_rank - right.status_rank ||
    Number(right.needs_attention) - Number(left.needs_attention) ||
    Number(right.without_reason) - Number(left.without_reason) ||
    left.student_name.localeCompare(right.student_name, 'ru')
  );
}

function compareTodayPeriods(left, right, nowSql) {
  const leftStatus = todayPeriodStatus(left, nowSql);
  const rightStatus = todayPeriodStatus(right, nowSql);
  if (leftStatus.rank !== rightStatus.rank) return leftStatus.rank - rightStatus.rank;

  if (leftStatus.code === 'future') {
    return String(left.starts_at).localeCompare(String(right.starts_at)) || String(left.id).localeCompare(String(right.id));
  }
  if (leftStatus.code === 'completed') {
    return String(right.ends_at || right.starts_at).localeCompare(String(left.ends_at || left.starts_at))
      || String(right.starts_at).localeCompare(String(left.starts_at))
      || String(left.id).localeCompare(String(right.id));
  }
  return String(left.starts_at).localeCompare(String(right.starts_at)) || String(left.id).localeCompare(String(right.id));
}

function todayPeriodStatus(period, nowSql) {
  const startsAt = String(period?.starts_at || '');
  const endsAt = String(period?.ends_at || FAR_FUTURE);
  if (startsAt <= nowSql && endsAt >= nowSql) {
    return { code: 'now', label: 'сейчас', rank: 0, className: 'bg-indigo-100 text-indigo-800' };
  }
  if (startsAt > nowSql) {
    return { code: 'future', label: 'позже сегодня', rank: 1, className: 'bg-sky-100 text-sky-800' };
  }
  return { code: 'completed', label: 'уже завершено', rank: 2, className: 'bg-gray-100 text-gray-700' };
}

function formatTodayAbsencePeriodLabel(startsAt, endsAt, date) {
  const start = parseCompactDateTime(startsAt);
  const end = parseCompactDateTime(endsAt);
  if (!start) return '';
  if (!end) {
    return start.date === date ? `с ${start.time}` : `с ${start.short}`;
  }
  if (start.date === date && end.date === date) {
    return `${start.time} — ${end.time}`;
  }
  if (start.date === date) {
    return `${start.time} — ${end.short}`;
  }
  if (end.date === date) {
    return `${start.short} — ${end.time}`;
  }
  return `${start.short} — ${end.short}`;
}

function parseCompactDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  return {
    date: `${y}-${mo}-${d}`,
    time: `${h}:${mi}`,
    short: `${d}.${mo} ${h}:${mi}`,
  };
}

function attendanceHref({ classId, studentId, date }) {
  const params = new URLSearchParams();
  if (classId) params.set('class', classId);
  if (studentId) params.set('student', studentId);
  if (date) params.set('date', date);
  const query = params.toString();
  return query ? `/attendance?${query}` : '/attendance';
}

function toPositiveInt(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ValidationError(`Некорректное значение ${field}`);
  }
  return number;
}

function normalizeDateTime(value, options = {}) {
  const { field = 'date', required = false, dateOnlyEnd = false } = options;
  const raw = String(value ?? '').trim();
  if (!raw) {
    if (required) throw new ValidationError('Укажите время начала отсутствия');
    return null;
  }

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    throw new ValidationError(`Некорректный формат даты ${field}`);
  }

  const [, y, mo, d, h, mi, s] = match;
  const hasTime = h != null;
  const hour = hasTime ? Number(h) : dateOnlyEnd ? 23 : 0;
  const minute = hasTime ? Number(mi) : dateOnlyEnd ? 59 : 0;
  const second = hasTime ? Number(s || 0) : dateOnlyEnd ? 59 : 0;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);

  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new ValidationError(`Некорректная дата ${field}`);
  }

  return `${y}-${mo}-${d} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function normalizeComment(value) {
  const comment = String(value ?? '').trim();
  if (comment.length > 1000) {
    throw new ValidationError('Комментарий не должен быть длиннее 1000 символов');
  }
  return comment || null;
}

function normalizeChoice(value, allowed, fallback, field) {
  const normalized = String(value || fallback).trim();
  if (!allowed.includes(normalized)) {
    throw new ValidationError(`Некорректное значение ${field}`);
  }
  return normalized;
}

async function recordAbsenceEvent({ absenceId, actorId, eventType, before, after }) {
  await usr.query(
    `INSERT INTO attendance.absence_period_events
      (absence_id, actor_id, event_type, before_json, after_json)
     VALUES (?, ?, ?, ?, ?)`,
    [
      absenceId,
      actorId || null,
      eventType,
      before ? JSON.stringify(toEventPayload(before)) : null,
      after ? JSON.stringify(toEventPayload(after)) : null,
    ],
  );
}

function toEventPayload(absence) {
  return {
    id: absence.id,
    student_id: absence.student_id,
    class_id: absence.class_id,
    starts_at: absence.starts_at,
    ends_at: absence.ends_at,
    reason_code: absence.reason_code,
    comment: absence.comment,
    source: absence.source,
    confirmation_status: absence.confirmation_status,
    attention_status: absence.attention_status,
    resolved_at: absence.resolved_at,
    resolved_by: absence.resolved_by,
  };
}

async function assertPresenceStudent(studentId, classId) {
  const normalizedStudentId = toPositiveInt(studentId, 'studentId');
  const normalizedClassId = toPositiveInt(classId, 'classId');
  const student = await getStudentById(normalizedStudentId);
  if (!student) {
    throw new ValidationError('Ученик не найден');
  }
  if (String(student.classId) !== String(normalizedClassId)) {
    throw new ValidationError('Класс не совпадает с классом ученика');
  }
  return {
    id: normalizedStudentId,
    classId: normalizedClassId,
    name: student.name || '',
  };
}

async function acquirePresenceLock(conn, studentId, date) {
  const [rows] = await conn.query('SELECT GET_LOCK(?, 3) AS locked', [presenceLockName(studentId, date)]);
  return Number(rows[0]?.locked || 0) === 1;
}

async function releasePresenceLock(conn, studentId, date) {
  if (!studentId || !date) return;
  try {
    await conn.query('DO RELEASE_LOCK(?)', [presenceLockName(studentId, date)]);
  } catch {
    // The connection is about to be released; losing the lock release error is safer than hiding the real request error.
  }
}

function presenceLockName(studentId, date) {
  return `attendance:presence:${studentId}:${date}`;
}

async function getPresenceEventById(conn, id) {
  const [rows] = await conn.query(
    `${presenceEventSelectSql()}
      WHERE e.id = ?
      LIMIT 1`,
    [id],
  );
  return rows[0] ? mapPresenceEvent(rows[0]) : null;
}

async function getActivePresenceEventByIdForUpdate(conn, id) {
  const [rows] = await conn.query(
    `${presenceEventSelectSql()}
      WHERE e.id = ?
        AND e.cancelled_at IS NULL
      LIMIT 1
      FOR UPDATE`,
    [id],
  );
  return rows[0] ? mapPresenceEvent(rows[0]) : null;
}

async function getPresenceEventByIdempotencyKey(conn, idempotencyKey) {
  if (!idempotencyKey) return null;
  const [rows] = await conn.query(
    `${presenceEventSelectSql()}
      WHERE e.idempotency_key = ?
      LIMIT 1`,
    [idempotencyKey],
  );
  return rows[0] ? mapPresenceEvent(rows[0]) : null;
}

async function getLatestPresenceEventForUpdate(conn, studentId, date) {
  const [rows] = await conn.query(
    `${presenceEventSelectSql()}
      WHERE e.student_id = ?
        AND e.attendance_date = ?
        AND e.cancelled_at IS NULL
      ORDER BY e.occurred_at DESC, e.id DESC
      LIMIT 1
      FOR UPDATE`,
    [studentId, date],
  );
  return rows[0] ? mapPresenceEvent(rows[0]) : null;
}

function presenceEventSelectSql() {
  return `
    SELECT
      CAST(e.id AS CHAR) AS id,
      CAST(e.student_id AS CHAR) AS student_id,
      CAST(e.class_id AS CHAR) AS class_id,
      e.event_type,
      DATE_FORMAT(e.occurred_at, '%Y-%m-%d %H:%i:%s') AS occurred_at,
      DATE_FORMAT(e.attendance_date, '%Y-%m-%d') AS attendance_date,
      CAST(e.actor_id AS CHAR) AS actor_id,
      e.source,
      DATE_FORMAT(e.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelled_at,
      CAST(e.cancelled_by AS CHAR) AS cancelled_by,
      e.idempotency_key,
      DATE_FORMAT(e.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
      DATE_FORMAT(e.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
      COALESCE(NULLIF(u.display_name_custom, ''), NULLIF(u.nickname, ''), NULLIF(u.msgnickname, ''), u.name) AS student_name,
      k.name AS class_name
    FROM attendance.presence_events e
    LEFT JOIN sso.users u ON u.id = e.student_id
    LEFT JOIN sso.kaf_name k ON k.id = e.class_id
  `;
}

function mapPresenceEvent(row) {
  const eventType = row.event_type === PRESENCE_EVENT_TYPES.DEPARTURE
    ? PRESENCE_EVENT_TYPES.DEPARTURE
    : PRESENCE_EVENT_TYPES.ARRIVAL;
  const occurredAt = row.occurred_at || '';
  const occurredLabel = formatPresenceEventDateTime(occurredAt);
  return {
    id: row.id,
    student_id: row.student_id,
    class_id: row.class_id,
    student_name: row.student_name || '',
    class_name: row.class_name || '',
    event_type: eventType,
    event_label: presenceEventTypeLabel(eventType),
    occurred_at: occurredAt,
    occurred_time: occurredAt.slice(11, 19),
    occurred_label: occurredLabel,
    attendance_date: row.attendance_date || dateOnlyFromSql(occurredAt),
    actor_id: row.actor_id,
    source: row.source || 'tablet',
    cancelled_at: row.cancelled_at || '',
    cancelled_by: row.cancelled_by,
    idempotency_key: row.idempotency_key || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  };
}

function presenceStateFromEvent(latestEvent) {
  const hasEvent = Boolean(latestEvent?.id);
  const isPresent = latestEvent?.event_type === PRESENCE_EVENT_TYPES.ARRIVAL;
  const statusWord = hasEvent ? presenceEventTypeLabel(latestEvent.event_type) : 'Нет отметки';
  const statusTime = latestEvent?.occurred_label || formatPresenceEventDateTime(latestEvent?.occurred_at);
  const statusCode = hasEvent ? (isPresent ? 'present' : 'departed') : 'none';
  return {
    has_event: hasEvent,
    is_present: isPresent,
    status_code: statusCode,
    last_event_id: latestEvent?.id || '',
    last_event_type: latestEvent?.event_type || '',
    status_word: statusWord,
    status_time: statusTime,
    status_label: hasEvent ? `${statusWord} ${statusTime}` : statusWord,
    status_badge_label: statusWord,
    status_detail: statusTime,
    next_event_type: isPresent ? PRESENCE_EVENT_TYPES.DEPARTURE : PRESENCE_EVENT_TYPES.ARRIVAL,
    next_action_label: isPresent ? 'Ушёл' : 'Пришёл',
  };
}

function presenceEventTypeLabel(eventType) {
  return eventType === PRESENCE_EVENT_TYPES.DEPARTURE ? 'Ушёл' : 'Пришёл';
}

function formatPresenceEventDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return '';
  const [, y, mo, d, h, mi, s] = match;
  return `${h}:${mi}:${s} ${d}.${mo}.${y.slice(2)}`;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return null;
  if (key.length > 64) {
    throw new ValidationError('Слишком длинный ключ запроса');
  }
  return key;
}

function isDuplicateKeyError(err) {
  return err?.code === 'ER_DUP_ENTRY' || Number(err?.errno || 0) === 1062;
}

function dateOnlyFromSql(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : todayDate();
}

function sqlNow() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function todayDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function schoolDayBoundsPayload(date, weekday, startTime, endTime, fromSchedule) {
  const startsAt = `${date} ${startTime}`;
  const endsAt = `${date} ${endTime}`;
  return {
    date,
    weekday,
    start_time: startTime,
    end_time: endTime,
    start_label: startTime.slice(0, 5),
    end_label: endTime.slice(0, 5),
    starts_at: startsAt,
    ends_at: endsAt,
    start_input: toDateTimeLocal(startsAt),
    end_input: toDateTimeLocal(endsAt),
    from_schedule: Boolean(fromSchedule),
  };
}

function weekdayFromDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function normalizeClockTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return '';
  const [, hourText, minuteText, secondText = '00'] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return '';
  return `${hourText}:${minuteText}:${secondText}`;
}

function compareClockTimes(left, right) {
  return clockTimeSeconds(left) - clockTimeSeconds(right);
}

function clockTimeSeconds(value) {
  const normalized = normalizeClockTime(value);
  if (!normalized) return 0;
  const [hour, minute, second] = normalized.split(':').map(Number);
  return hour * 3600 + minute * 60 + second;
}

function daysAgoDateTime(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 00:00:00`;
}

function normalizeDateOnly(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new ValidationError('Некорректная дата обзора');
  }
  const [, y, mo, d] = match;
  const candidate = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    candidate.getUTCFullYear() !== Number(y) ||
    candidate.getUTCMonth() + 1 !== Number(mo) ||
    candidate.getUTCDate() !== Number(d)
  ) {
    throw new ValidationError('Некорректная дата обзора');
  }
  return raw;
}

function toDateTimeLocal(value) {
  return value ? String(value).slice(0, 16).replace(' ', 'T') : '';
}

function formatPeriodLabel(startsAt, endsAt) {
  if (!startsAt) return '';
  const start = formatDisplayDateTime(startsAt);
  const end = endsAt ? formatDisplayDateTime(endsAt) : '';
  return end ? `${start} — ${end}` : `с ${start}`;
}

function formatDisplayDateTime(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return String(value || '');
  const [, y, mo, d, h, mi] = match;
  return `${d}.${mo}.${y} ${h}:${mi}`;
}

function attentionLabel(value) {
  switch (value) {
    case 'needs_attention': return 'Требует внимания';
    case 'resolved': return 'Закрыто';
    default: return 'Обычная';
  }
}

function confirmationLabel(value) {
  switch (value) {
    case 'reported': return 'Со слов';
    case 'needs_clarification': return 'Требует уточнения';
    case 'system_conflict': return 'Конфликт с системой';
    default: return 'Подтверждено';
  }
}
