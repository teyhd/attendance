# Face Module - инструкции для агентов

Этот каталог содержит Python-модуль распознавания лиц для Attendance.

- Не коммить датасеты лиц, ONNX-модели, индексы эмбеддингов, `.env`, логи и снимки с камеры.
- Runtime-данные храни в `face_module/data/`, модели - в `face_module/models/`.
- Не пиши в `sso.*`, `school_local.sso_users`, `school_local.sso_kafs`.
- Для журнала прихода/ухода используй только `attendance.presence_events` с `source = 'face'`.
- `sso.users` можно использовать только read-only для проверки ученика.
