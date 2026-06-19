INSERT INTO attendance.absence_reasons
  (code, name, is_excused, requires_attention, default_confirmation_status, sort_order, active)
VALUES
  ('illness', 'Болезнь', 1, 0, 'confirmed', 10, 1),
  ('family', 'Семейные обстоятельства', 1, 0, 'confirmed', 20, 1),
  ('trip', 'Соревнования', 1, 0, 'confirmed', 30, 1),
  ('olympiad', 'Олимпиада', 1, 0, 'confirmed', 40, 1),
  ('medical_checkup', 'Медосмотр', 1, 0, 'confirmed', 50, 1),
  ('excused', 'Уважительная причина', 1, 0, 'reported', 60, 1),
  ('other', 'Другое', 0, 0, 'reported', 70, 1),
  ('without_reason', 'Без причины', 0, 1, 'needs_clarification', 80, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  is_excused = VALUES(is_excused),
  requires_attention = VALUES(requires_attention),
  default_confirmation_status = VALUES(default_confirmation_status),
  sort_order = VALUES(sort_order),
  active = VALUES(active);
