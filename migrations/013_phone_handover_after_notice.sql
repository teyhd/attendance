ALTER TABLE attendance.student_phone_handover
  ADD COLUMN IF NOT EXISTS submitted_after_notice_at DATETIME NULL AFTER submitted,
  ADD COLUMN IF NOT EXISTS submitted_after_notice_by INT NULL AFTER submitted_after_notice_at;

CREATE TABLE IF NOT EXISTS attendance.student_phone_notice_changes (
  student_id INT NOT NULL,
  attendance_date DATE NOT NULL,
  revision INT UNSIGNED NOT NULL,
  actor_id INT NULL,
  previous_at DATETIME NULL,
  previous_by INT NULL,
  submitted_at DATETIME NULL,
  submitted_by INT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, attendance_date, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
