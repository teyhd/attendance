CREATE TABLE IF NOT EXISTS attendance.lesson_attendance_facts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_service VARCHAR(32) NOT NULL,
  source_record_id VARCHAR(64) NOT NULL,
  source_version BIGINT UNSIGNED NOT NULL,
  lesson_id VARCHAR(64) NOT NULL,
  schedule_entry_id VARCHAR(64) NULL,
  student_id INT NOT NULL,
  class_id INT NOT NULL,
  subject_id INT NOT NULL,
  teacher_id INT NULL,
  lesson_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL,
  late_minutes SMALLINT UNSIGNED NULL,
  source_updated_at DATETIME NULL,
  deleted_at DATETIME NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lesson_fact_source_record (source_service, source_record_id),
  KEY idx_lesson_fact_student_date (student_id, lesson_date),
  KEY idx_lesson_fact_class_date (class_id, lesson_date),
  KEY idx_lesson_fact_subject_date (subject_id, lesson_date),
  KEY idx_lesson_fact_schedule_entry (schedule_entry_id, student_id),
  CONSTRAINT fk_lesson_fact_student
    FOREIGN KEY (student_id) REFERENCES sso.users (id)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_lesson_fact_status
    CHECK (status IN ('present', 'absent', 'late', 'sick', 'excused'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
