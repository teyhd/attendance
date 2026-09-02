CREATE TABLE IF NOT EXISTS attendance.presence_absence_conflicts (
  id INT NOT NULL AUTO_INCREMENT,
  student_id INT NOT NULL,
  class_id INT NOT NULL,
  absence_id INT NOT NULL,
  presence_event_id INT NOT NULL,
  conflict_type VARCHAR(32) NOT NULL DEFAULT 'arrival_during_absence',
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  resolution_code VARCHAR(32) NULL,
  resolved_by INT NULL,
  resolved_at DATETIME NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_presence_absence_conflict (absence_id, presence_event_id, conflict_type),
  KEY idx_attendance_conflict_status_class (status, class_id, created_at),
  KEY idx_attendance_conflict_student_status (student_id, status, created_at),
  CONSTRAINT fk_attendance_conflict_absence
    FOREIGN KEY (absence_id) REFERENCES attendance.absence_periods (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_attendance_conflict_presence
    FOREIGN KEY (presence_event_id) REFERENCES attendance.presence_events (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO attendance.absence_period_events
  (absence_id, actor_id, event_type, before_json, after_json)
SELECT
  p.id,
  NULL,
  'migration_closed_open',
  JSON_OBJECT('id', p.id, 'ends_at', NULL),
  JSON_OBJECT(
    'id', p.id,
    'ends_at', DATE_FORMAT(
      GREATEST(
        DATE_ADD(p.starts_at, INTERVAL 1 MINUTE),
        TIMESTAMP(
          DATE(p.starts_at),
          COALESCE((
            SELECT LEAST(MAX(ts.end_time), '19:00:00')
              FROM school_local.schedule_time_slots ts
             WHERE ts.is_active = 1
               AND ts.day_of_week = WEEKDAY(DATE(p.starts_at)) + 1
          ), '19:00:00')
        )
      ),
      '%Y-%m-%d %H:%i:%s'
    )
  )
FROM attendance.absence_periods p
WHERE p.ends_at IS NULL
  AND NOT EXISTS (
    SELECT 1
      FROM attendance.absence_period_events e
     WHERE e.absence_id = p.id
       AND e.event_type = 'migration_closed_open'
  );

UPDATE attendance.absence_periods p
SET p.ends_at = GREATEST(
  DATE_ADD(p.starts_at, INTERVAL 1 MINUTE),
  TIMESTAMP(
    DATE(p.starts_at),
    COALESCE((
      SELECT LEAST(MAX(ts.end_time), '19:00:00')
        FROM school_local.schedule_time_slots ts
       WHERE ts.is_active = 1
         AND ts.day_of_week = WEEKDAY(DATE(p.starts_at)) + 1
    ), '19:00:00')
  )
)
WHERE p.ends_at IS NULL;

ALTER TABLE attendance.absence_periods
  MODIFY COLUMN ends_at DATETIME NOT NULL;

INSERT INTO attendance.presence_absence_conflicts
  (student_id, class_id, absence_id, presence_event_id, conflict_type)
SELECT
  p.student_id,
  p.class_id,
  p.id,
  e.id,
  'arrival_during_absence'
FROM attendance.absence_periods p
JOIN attendance.presence_events e
  ON e.student_id = p.student_id
 AND e.event_type = 'arrival'
 AND e.cancelled_at IS NULL
 AND e.occurred_at >= p.starts_at
 AND e.occurred_at < p.ends_at
WHERE p.deleted_at IS NULL
ON DUPLICATE KEY UPDATE
  updated_at = CURRENT_TIMESTAMP;
