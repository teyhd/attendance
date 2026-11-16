INSERT INTO attendance.absence_reasons
  (code, name, is_excused, requires_attention, default_confirmation_status, sort_order, active)
VALUES
  ('training', 'Тренировка', 1, 0, 'confirmed', 55, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  is_excused = VALUES(is_excused),
  requires_attention = VALUES(requires_attention),
  default_confirmation_status = VALUES(default_confirmation_status),
  sort_order = VALUES(sort_order),
  active = VALUES(active);
