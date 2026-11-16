ALTER TABLE attendance.student_phone_handover
  MODIFY COLUMN submitted TINYINT(1) NULL,
  ADD COLUMN IF NOT EXISTS picked_up TINYINT(1) NULL AFTER submitted;
