ALTER TABLE attendance.absence_reasons
  ADD COLUMN IF NOT EXISTS requires_attention TINYINT(1) NOT NULL DEFAULT 0 AFTER is_excused,
  ADD COLUMN IF NOT EXISTS default_confirmation_status VARCHAR(32) NOT NULL DEFAULT 'confirmed' AFTER requires_attention;

ALTER TABLE attendance.absence_periods
  ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'mentor' AFTER comment,
  ADD COLUMN IF NOT EXISTS confirmation_status VARCHAR(32) NOT NULL DEFAULT 'confirmed' AFTER source,
  ADD COLUMN IF NOT EXISTS attention_status VARCHAR(32) NOT NULL DEFAULT 'normal' AFTER confirmation_status,
  ADD COLUMN IF NOT EXISTS resolved_at DATETIME NULL AFTER attention_status,
  ADD COLUMN IF NOT EXISTS resolved_by INT NULL AFTER resolved_at,
  ADD KEY IF NOT EXISTS idx_absence_attention (attention_status, resolved_at),
  ADD KEY IF NOT EXISTS idx_absence_resolution (resolved_by, resolved_at);

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO attendance.absence_reasons
  (code, name, is_excused, requires_attention, default_confirmation_status, sort_order, active)
VALUES
  ('illness', 'Болезнь', 1, 0, 'confirmed', 10, 1),
  ('family', 'Семейные обстоятельства', 1, 0, 'confirmed', 20, 1),
  ('trip', 'Поездка', 1, 0, 'confirmed', 30, 1),
  ('other', 'Другое', 0, 1, 'needs_clarification', 40, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  is_excused = VALUES(is_excused),
  requires_attention = VALUES(requires_attention),
  default_confirmation_status = VALUES(default_confirmation_status),
  sort_order = VALUES(sort_order),
  active = VALUES(active);

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
WHERE p.deleted_at IS NULL;

CREATE OR REPLACE VIEW attendance.v_absence_daily_summary AS
SELECT
  p.class_id,
  DATE(p.starts_at) AS starts_date,
  COUNT(*) AS absence_count,
  COUNT(DISTINCT p.student_id) AS absent_students,
  SUM(p.reason_code = 'other') AS without_reason_count,
  SUM(p.attention_status = 'needs_attention') AS needs_attention_count,
  SUM(r.is_excused = 1) AS excused_count
FROM attendance.absence_periods p
JOIN attendance.absence_reasons r ON r.code = p.reason_code
WHERE p.deleted_at IS NULL
GROUP BY p.class_id, DATE(p.starts_at);
