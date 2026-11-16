CREATE TABLE IF NOT EXISTS attendance.mentor_work_weeks (
  week_start DATE NOT NULL,
  draft_json JSON NULL,
  published_json JSON NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  published_revision INT UNSIGNED NULL,
  updated_by INT NULL,
  published_by INT NULL,
  updated_at DATETIME NULL,
  published_at DATETIME NULL,
  PRIMARY KEY (week_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
