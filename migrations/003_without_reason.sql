INSERT INTO attendance.absence_reasons
  (code, name, is_excused, requires_attention, default_confirmation_status, sort_order, active)
VALUES
  ('without_reason', 'Без причины', 0, 1, 'needs_clarification', 40, 1),
  ('other', 'Другое', 0, 0, 'reported', 50, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  is_excused = VALUES(is_excused),
  requires_attention = VALUES(requires_attention),
  default_confirmation_status = VALUES(default_confirmation_status),
  sort_order = VALUES(sort_order),
  active = VALUES(active);

CREATE OR REPLACE VIEW attendance.v_absence_daily_summary AS
SELECT
  p.class_id,
  DATE(p.starts_at) AS starts_date,
  COUNT(*) AS absence_count,
  COUNT(DISTINCT p.student_id) AS absent_students,
  SUM(p.reason_code = 'without_reason') AS without_reason_count,
  SUM(p.attention_status = 'needs_attention') AS needs_attention_count,
  SUM(r.is_excused = 1) AS excused_count
FROM attendance.absence_periods p
JOIN attendance.absence_reasons r ON r.code = p.reason_code
WHERE p.deleted_at IS NULL
GROUP BY p.class_id, DATE(p.starts_at);
