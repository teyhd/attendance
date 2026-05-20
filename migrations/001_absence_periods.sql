CREATE TABLE IF NOT EXISTS attendance.absence_reasons (
  code VARCHAR(32) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_excused TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS attendance.absence_periods (
  id INT NOT NULL AUTO_INCREMENT,
  student_id INT NOT NULL,
  class_id INT NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NULL,
  reason_code VARCHAR(32) NOT NULL,
  comment TEXT NULL,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO attendance.absence_reasons
  (code, name, is_excused, sort_order, active)
VALUES
  ('illness', 'Болезнь', 1, 10, 1),
  ('family', 'Семейные обстоятельства', 1, 20, 1),
  ('trip', 'Поездка', 1, 30, 1),
  ('other', 'Другое', 0, 40, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  is_excused = VALUES(is_excused),
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
  p.comment,
  p.created_by,
  p.created_at,
  p.updated_at
FROM attendance.absence_periods p
JOIN attendance.absence_reasons r ON r.code = p.reason_code
WHERE p.deleted_at IS NULL;
