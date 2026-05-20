import mysql from 'mysql2';
import {
  buildMonthRange,
  expandDateRangeWithinMonth,
  normalizeAnalyticsMonth,
  percentOf,
} from './analytics.mjs';
import {
  OTHER_REASON_CODE,
  WITHOUT_REASON_CODE,
  isOtherReasonCode,
  isWithoutReasonCode,
} from './absence-reasons.mjs';

const FAR_FUTURE = '9999-12-31 23:59:59';

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
    INSERT INTO attendance.absence_reasons
      (code, name, is_excused, requires_attention, default_confirmation_status, sort_order, active)
    VALUES
      ('illness', 'Болезнь', 1, 0, 'confirmed', 10, 1),
      ('family', 'Семейные обстоятельства', 1, 0, 'confirmed', 20, 1),
      ('trip', 'Поездка', 1, 0, 'confirmed', 30, 1),
      ('${WITHOUT_REASON_CODE}', 'Без причины', 0, 1, 'needs_clarification', 40, 1),
      ('${OTHER_REASON_CODE}', 'Другое', 0, 0, 'reported', 50, 1)
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

export async function getClasses() {
  const [rows] = await usr.query(
    `SELECT CAST(id AS CHAR) AS id, name
       FROM sso.kaf_name
      WHERE type = 1 AND id > 0
      ORDER BY
        CASE WHEN NULLIF(REGEXP_SUBSTR(name, '^[0-9]+'), '') IS NULL THEN 1 ELSE 0 END,
        CAST(NULLIF(REGEXP_SUBSTR(name, '^[0-9]+'), '') AS UNSIGNED),
        name,
        id`,
  );
  return rows;
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

export async function getMonthlyAttendanceAnalytics({ month, classId } = {}) {
  const selectedMonth = normalizeAnalyticsMonth(month);
  const range = buildMonthRange(selectedMonth);
  const classes = await getClasses();
  const selectedClass = normalizeAnalyticsClass(classes, classId);
  const classFilter = selectedClass.id === 'all' ? null : selectedClass.id;
  const [students, periods] = await Promise.all([
    getMonthlyAnalyticsStudents(classFilter),
    getMonthlyAnalyticsPeriods(range, classFilter),
  ]);

  return buildMonthlyAnalytics({
    range,
    classes,
    selectedClass,
    students,
    periods,
  });
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

async function getMonthlyAnalyticsPeriods(range, classId) {
  const where = [
    'p.deleted_at IS NULL',
    'p.starts_at <= ?',
    'COALESCE(p.ends_at, p.starts_at) >= ?',
    'u.type = 1',
    'u.status = 1',
    'k.type = 1',
  ];
  const params = [range.end_at, range.start_at];
  if (classId) {
    where.push('p.class_id = ?');
    params.push(classId);
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

function buildMonthlyAnalytics({ range, classes, selectedClass, students, periods }) {
  const studentById = new Map(students.map((student) => [String(student.student_id), student]));
  const studentsByClass = new Map();
  const dailyBuckets = new Map(range.days.map((day) => [day, createDailyBucket(day)]));
  const reasonBuckets = new Map();
  const classBuckets = new Map();
  const riskBuckets = new Map();
  const absentStudents = new Set();
  const absenceDayKeys = new Set();

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

    const isWithoutReason = isWithoutReasonCode(period.reason_code);
    const needsAttention = period.attention_status === 'needs_attention';
    const needsClarification = period.confirmation_status === 'needs_clarification';
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
    riskBucket.periods += 1;

    if (!riskBucket.last_starts_at || String(period.starts_at) >= riskBucket.last_starts_at) {
      riskBucket.last_starts_at = String(period.starts_at || '');
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
    }
  }

  const totalAbsenceDays = absenceDayKeys.size;
  const dailyRows = Array.from(dailyBuckets.values()).map((bucket) => ({
    date: bucket.date,
    day_label: bucket.date.slice(8, 10),
    absent_students: bucket.absentStudents.size,
    absence_periods: bucket.periodIds.size,
    absence_days: bucket.absenceDays.size,
    without_reason: bucket.withoutReason.size,
    needs_attention: bucket.needsAttention.size,
  }));
  const maxDailyDays = Math.max(0, ...dailyRows.map((row) => row.absence_days));
  for (const row of dailyRows) {
    row.bar_width = maxDailyDays ? percentOf(row.absence_days, maxDailyDays) : 0;
    row.heat_style = dailyHeatStyle(row, maxDailyDays);
    row.heat_title = dailyHeatTitle(row);
  }
  const dailyCalendar = buildDailyCalendar(range, dailyRows);
  const dailyActiveRows = dailyRows.filter((row) => (
    row.absence_days > 0 ||
    row.absence_periods > 0 ||
    row.without_reason > 0 ||
    row.needs_attention > 0
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
      bar_class: isWithoutReasonCode(bucket.code) || isOtherReasonCode(bucket.code) ? 'bg-amber-500' : 'bg-emerald-600',
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
      without_reason: bucket.withoutReason.size,
      needs_attention: bucket.needsAttention.size,
    }))
    .filter((row) => selectedClass.id !== 'all' || row.students_total > 0 || row.periods > 0);
  const maxClassDays = Math.max(0, ...classRowsAll.map((row) => row.absence_days));
  for (const row of classRowsAll) {
    row.bar_width = maxClassDays ? percentOf(row.absence_days, maxClassDays) : 0;
  }
  classRowsAll.sort((a, b) => (
    b.absence_days - a.absence_days ||
    b.needs_attention - a.needs_attention ||
    b.without_reason - a.without_reason ||
    compareClassNames(a.class_name, b.class_name)
  ));
  const classRows = selectedClass.id === 'all'
    ? classRowsAll.filter((row) => row.periods > 0 || row.absence_days > 0 || row.without_reason > 0 || row.needs_attention > 0)
    : classRowsAll;

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
        selected: String(item.id) === String(selectedClass.id),
      })),
    ],
    kpi: {
      students_total: students.length,
      students_with_absences: absentStudents.size,
      absence_periods: totalPeriods,
      absence_days: totalAbsenceDays,
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

function compareClassNames(left, right) {
  const a = classNameParts(left);
  const b = classNameParts(right);
  if (a.hasNumber !== b.hasNumber) return a.hasNumber ? -1 : 1;
  if (a.number !== b.number) return a.number - b.number;
  return a.text.localeCompare(b.text, 'ru', { numeric: true, sensitivity: 'base' });
}

function classNameParts(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+)/);
  return {
    text,
    hasNumber: Boolean(match),
    number: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
  };
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

function dailyHeatStyle(row, maxDailyDays) {
  if (Number(row.needs_attention || 0) > 0) {
    return 'background-color:#fee2e2;border-color:#fecaca;color:#991b1b;';
  }
  if (Number(row.without_reason || 0) > 0) {
    return 'background-color:#fef3c7;border-color:#fde68a;color:#92400e;';
  }
  if (Number(row.absence_days || 0) <= 0) {
    return 'background-color:#f8fafc;border-color:#e2e8f0;color:#94a3b8;';
  }

  const ratio = maxDailyDays ? Number(row.absence_days || 0) / maxDailyDays : 0;
  if (ratio >= 0.67) {
    return 'background-color:#4f46e5;border-color:#4f46e5;color:#ffffff;';
  }
  if (ratio >= 0.34) {
    return 'background-color:#c7d2fe;border-color:#a5b4fc;color:#3730a3;';
  }
  return 'background-color:#e0e7ff;border-color:#c7d2fe;color:#3730a3;';
}

function dailyHeatTitle(row) {
  const parts = [
    row.date,
    `ученик-дней: ${Number(row.absence_days || 0)}`,
    `учеников: ${Number(row.absent_students || 0)}`,
    `периодов: ${Number(row.absence_periods || 0)}`,
  ];
  if (Number(row.without_reason || 0) > 0) parts.push(`без причины: ${Number(row.without_reason || 0)}`);
  if (Number(row.needs_attention || 0) > 0) parts.push(`внимание: ${Number(row.needs_attention || 0)}`);
  return parts.join(' · ');
}

function createDailyBucket(date) {
  return {
    date,
    absentStudents: new Set(),
    periodIds: new Set(),
    absenceDays: new Set(),
    withoutReason: new Set(),
    needsAttention: new Set(),
  };
}

function createClassBucket(item) {
  return {
    class_id: String(item.id ?? item.class_id ?? ''),
    class_name: item.name || item.class_name || '',
    students_total: 0,
    absentStudents: new Set(),
    periodIds: new Set(),
    absenceDays: new Set(),
    withoutReason: new Set(),
    needsAttention: new Set(),
    periods: 0,
  };
}

function ensureClassBucket(map, item) {
  const classId = String(item.id ?? item.class_id ?? '');
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
