-- Additive history metadata only. Does not close or rewrite absence periods.
ALTER TABLE attendance.absence_periods
  ADD COLUMN IF NOT EXISTS revision INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE attendance.presence_events
  ADD COLUMN IF NOT EXISTS revision INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE attendance.absence_period_events
  ADD COLUMN IF NOT EXISTS reason VARCHAR(1000) NULL;

CREATE TABLE IF NOT EXISTS attendance.presence_event_changes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  presence_event_id INT NOT NULL,
  actor_id INT NULL,
  event_type VARCHAR(32) NOT NULL,
  reason VARCHAR(1000) NULL,
  before_json LONGTEXT NULL,
  after_json LONGTEXT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_presence_changes_event (presence_event_id, id),
  CONSTRAINT fk_presence_change_event FOREIGN KEY (presence_event_id)
    REFERENCES attendance.presence_events (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
