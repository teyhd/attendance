CREATE TABLE IF NOT EXISTS attendance.student_phone_handover (
  student_id INT NOT NULL,
  attendance_date DATE NOT NULL,
  submitted TINYINT(1) NOT NULL,
  updated_by INT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, attendance_date),
  KEY idx_phone_handover_date (attendance_date),
  CONSTRAINT chk_phone_handover_submitted CHECK (submitted IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
