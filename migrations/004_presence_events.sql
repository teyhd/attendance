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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
