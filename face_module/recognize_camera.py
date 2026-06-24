from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import sys
import time
from typing import Any

try:
    from .attendance_log import (
        ARRIVAL,
        DEPARTURE,
        AttendanceLogError,
        AttendanceLogger,
        AttendanceResult,
        StudentRecord,
        next_presence_event_type,
    )
    from .camera import open_camera
    from .face_module import FaceIndex, OpenCVFaceEngine, model_default_paths
    from .preview import PreviewWindow
except ImportError:
    from attendance_log import (
        ARRIVAL,
        DEPARTURE,
        AttendanceLogError,
        AttendanceLogger,
        AttendanceResult,
        StudentRecord,
        next_presence_event_type,
    )
    from camera import open_camera
    from face_module import FaceIndex, OpenCVFaceEngine, model_default_paths
    from preview import PreviewWindow


STATUS_LABELS = {
    "idle": "Ожидание",
    "candidate": "Подтверждение",
    "confirmed": "Отмечено",
    "wait_leave": "Отойдите от камеры",
    "no_face": "Нет лица",
    "multiple_faces": "Несколько лиц",
    "low_quality": "Плохое качество",
    "unknown": "Не распознано",
    "ambiguous": "Неуверенное совпадение",
    "recognized": "Лицо распознано",
    "unresolved_student": "Нет в SSO",
    "camera_error": "Ошибка камеры",
    "session_timeout": "Сеанс завершён",
}

RESULT_LABELS = {
    "inserted": "Записано",
    "dry_run": "Тестовый режим",
    "duplicate": "Повтор",
    "cooldown": "Пауза",
    "attendance_log_failed": "Ошибка записи",
}

REASON_LABELS = {
    "below_threshold": "Недостаточная уверенность",
    "low_margin": "Похожие кандидаты",
    "student_not_found": "Нет в SSO",
    "small_face": "Подойдите ближе",
    "blurred": "Изображение смазано",
    "underexposed": "Слишком темно",
    "overexposed": "Слишком ярко",
    "no_face": "Нет лица",
    "multiple_faces": "В кадре несколько лиц",
}


@dataclass(frozen=True)
class GateConfig:
    stable_seconds: float = 1.5
    min_stable_frames: int = 8
    leave_seconds: float = 1.0


@dataclass(frozen=True)
class RecognitionObservation:
    status: str
    student_id: str = ""
    similarity: float = 0.0
    confidence: float = 0.0
    reason: str = ""

    @property
    def recognized(self) -> bool:
        return self.status == "recognized" and bool(self.student_id)


@dataclass(frozen=True)
class GateDecision:
    state: str
    progress: float = 0.0
    stable_frames: int = 0
    stable_seconds: float = 0.0
    student_id: str = ""
    confirmed_student_id: str = ""
    reason: str = ""

    @property
    def confirmed(self) -> bool:
        return bool(self.confirmed_student_id)


class RecognitionGate:
    def __init__(self, config: GateConfig | None = None) -> None:
        self.config = config or GateConfig()
        self._candidate_id = ""
        self._candidate_started_at = 0.0
        self._candidate_frames = 0
        self._waiting_for_leave_id = ""
        self._leave_started_at: float | None = None

    def update(self, observation: RecognitionObservation, now: float) -> GateDecision:
        if self._waiting_for_leave_id:
            decision = self._update_wait_leave(observation, now)
            if decision.state == "wait_leave":
                return decision

        if not observation.recognized:
            self._reset_candidate()
            return GateDecision(state="idle", reason=observation.status or observation.reason)

        if observation.student_id != self._candidate_id:
            self._candidate_id = observation.student_id
            self._candidate_started_at = now
            self._candidate_frames = 1
        else:
            self._candidate_frames += 1

        elapsed = max(0.0, now - self._candidate_started_at)
        progress = min(frame_progress(self._candidate_frames, self.config.min_stable_frames), time_progress(elapsed, self.config.stable_seconds))
        if self._candidate_frames >= self.config.min_stable_frames and elapsed >= self.config.stable_seconds:
            confirmed_id = self._candidate_id
            frames = self._candidate_frames
            self._waiting_for_leave_id = confirmed_id
            self._leave_started_at = None
            self._reset_candidate()
            return GateDecision(
                state="confirmed",
                progress=1.0,
                stable_frames=frames,
                stable_seconds=elapsed,
                student_id=confirmed_id,
                confirmed_student_id=confirmed_id,
            )

        return GateDecision(
            state="candidate",
            progress=progress,
            stable_frames=self._candidate_frames,
            stable_seconds=elapsed,
            student_id=self._candidate_id,
        )

    def _update_wait_leave(self, observation: RecognitionObservation, now: float) -> GateDecision:
        if observation.recognized and observation.student_id == self._waiting_for_leave_id:
            self._leave_started_at = None
            return GateDecision(
                state="wait_leave",
                student_id=self._waiting_for_leave_id,
                reason="same_person_still_in_frame",
            )

        if self._leave_started_at is None:
            self._leave_started_at = now
        leave_elapsed = max(0.0, now - self._leave_started_at)
        if leave_elapsed < self.config.leave_seconds:
            return GateDecision(
                state="wait_leave",
                progress=time_progress(leave_elapsed, self.config.leave_seconds),
                student_id=self._waiting_for_leave_id,
                reason="waiting_for_leave",
            )

        self._waiting_for_leave_id = ""
        self._leave_started_at = None
        return GateDecision(state="idle", reason="left_frame")

    def _reset_candidate(self) -> None:
        self._candidate_id = ""
        self._candidate_started_at = 0.0
        self._candidate_frames = 0


def frame_progress(frame_count: int, required_frames: int) -> float:
    if required_frames <= 0:
        return 1.0
    return min(1.0, max(0.0, frame_count / required_frames))


def time_progress(elapsed: float, required_seconds: float) -> float:
    if required_seconds <= 0:
        return 1.0
    return min(1.0, max(0.0, elapsed / required_seconds))


def parse_args() -> argparse.Namespace:
    detector_model, recognizer_model = model_default_paths()
    parser = argparse.ArgumentParser(description="Распознавание лиц с камеры и отметка прихода/ухода.")
    parser.add_argument("--camera", default="HD Webcam", help="Камера: 'HD Webcam', 'laptop' или числовой индекс.")
    parser.add_argument("--index", default="face_module/data/face_index.npz", help="Путь к индексу лиц NPZ.")
    parser.add_argument("--detector-model", default=str(detector_model), help="Путь к ONNX-модели YuNet.")
    parser.add_argument("--recognizer-model", default=str(recognizer_model), help="Путь к ONNX-модели SFace.")
    parser.add_argument("--detector-threshold", type=float, default=0.85, help="Порог детектора YuNet.")
    parser.add_argument("--log-attendance", action="store_true", help="Записывать подтвержденные события в attendance.presence_events.")
    parser.add_argument("--db-env", action="append", default=[], help="Дополнительный .env-файл с настройками БД. Можно указать несколько раз.")
    parser.add_argument("--station-id", default="main-door", help="Идентификатор точки прохода для idempotency key.")
    parser.add_argument("--stable-seconds", type=float, default=1.5, help="Сколько секунд лицо должно распознаваться стабильно.")
    parser.add_argument("--min-stable-frames", type=int, default=8, help="Минимум стабильных кадров для подтверждения.")
    parser.add_argument("--leave-seconds", type=float, default=1.0, help="Сколько секунд лицо должно отсутствовать перед следующей отметкой.")
    parser.add_argument("--event-cooldown-seconds", type=int, default=20, help="Пауза в БД от повторных событий.")
    parser.add_argument("--max-session-seconds", type=float, default=0.0, help="Остановить через N секунд; 0 значит без лимита.")
    parser.add_argument("--sound", dest="sound", action="store_true", default=True, help="Включить звуки событий.")
    parser.add_argument("--no-sound", dest="sound", action="store_false", help="Отключить звуки событий.")
    parser.add_argument("--no-preview", action="store_true", help="Отключить окно предпросмотра.")
    parser.add_argument("--max-frames", type=int, default=0, help="Остановить через N кадров; 0 значит до закрытия окна.")
    parser.add_argument("--print-every", type=int, default=10, help="Печатать JSON каждые N кадров, если статус не менялся.")
    return parser.parse_args()


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    configure_stdio()
    args = parse_args()
    index = FaceIndex.load(args.index)
    engine = OpenCVFaceEngine(
        args.detector_model,
        args.recognizer_model,
        detector_score_threshold=args.detector_threshold,
    )
    logger = AttendanceLogger(env_files=args.db_env)
    if args.log_attendance:
        try:
            logger.check_ready()
        except AttendanceLogError as exc:
            emit({
                "status": "attendance_log_error",
                "attendance_status": "error",
                **exc.to_payload(),
            })
            return 2
    gate = RecognitionGate(GateConfig(
        stable_seconds=max(0.0, args.stable_seconds),
        min_stable_frames=max(1, args.min_stable_frames),
        leave_seconds=max(0.0, args.leave_seconds),
    ))
    student_cache: dict[str, StudentRecord] = {}
    dry_run_state: dict[str, str] = {}

    selected_camera = open_camera(args.camera)
    cap = selected_camera.capture
    preview = None if args.no_preview else PreviewWindow("Учёт посещаемости")
    print(f"камера: {selected_camera.description}", flush=True)

    frame_no = 0
    session_started_at = time.monotonic()
    last_print_key: tuple[Any, ...] | None = None
    flash_label = ""
    flash_kind = "success"
    flash_until = 0.0
    last_attendance_result: dict[str, Any] | None = None
    last_warning_key: tuple[str, str] | None = None

    try:
        while True:
            loop_now = time.monotonic()
            if args.max_session_seconds and loop_now - session_started_at >= args.max_session_seconds:
                emit({"status": "session_timeout", "max_session_seconds": args.max_session_seconds})
                break

            ok, frame = cap.read()
            if not ok:
                observation = RecognitionObservation(status="camera_error", reason="frame_read_failed")
                decision = gate.update(observation, loop_now)
                emit({"status": "camera_error", "attendance_status": decision.state, "reason": "frame_read_failed"})
                time.sleep(0.2)
                continue

            frame_no += 1
            result = engine.extract_single_embedding(frame)
            detections = [result.detection] if result.detection else []
            payload, observation = build_recognition_payload(
                result,
                index,
                logger,
                student_cache,
                frame_no,
                require_student_resolution=args.log_attendance,
            )
            decision = gate.update(observation, loop_now)

            attendance_payload = None
            if decision.confirmed:
                student = student_cache.get(decision.confirmed_student_id) or StudentRecord(
                    id=decision.confirmed_student_id,
                    name=f"ID {decision.confirmed_student_id}",
                    class_id="",
                )
                attendance_payload = handle_confirmed_student(
                    student=student,
                    logger=logger,
                    log_attendance=args.log_attendance,
                    station_id=args.station_id,
                    cooldown_seconds=args.event_cooldown_seconds,
                    dry_run_state=dry_run_state,
                    student_cache=student_cache,
                )
                last_attendance_result = attendance_payload
                if attendance_payload.get("attendance_result") in {"inserted", "dry_run"}:
                    play_event_sound(args.sound, attendance_payload.get("event_type", ""))
                    flash_label = flash_label_for_attendance(attendance_payload)
                    flash_kind = flash_theme_for_attendance(attendance_payload)
                    flash_until = loop_now + 1.6
                elif attendance_payload.get("attendance_result") == "attendance_log_failed":
                    play_warning_sound(args.sound)
                    flash_label = "Ошибка записи"
                    flash_kind = "error"
                    flash_until = loop_now + 1.6

            payload.update({
                "attendance_status": decision.state,
                "progress": round(decision.progress, 3),
                "stable_frames": decision.stable_frames,
                "stable_seconds": round(decision.stable_seconds, 3),
            })
            if attendance_payload:
                payload.update(attendance_payload)
            warning_key = (str(payload.get("status") or ""), str(payload.get("student_id") or ""))
            if payload.get("status") == "unresolved_student" and warning_key != last_warning_key:
                play_warning_sound(args.sound)
                flash_label = "Нет в SSO"
                flash_kind = "error"
                flash_until = loop_now + 1.4
                last_warning_key = warning_key

            print_key = (
                payload.get("status"),
                payload.get("attendance_status"),
                payload.get("student_id"),
                payload.get("attendance_result"),
                int(float(payload.get("progress") or 0.0) * 10),
            )
            if print_key != last_print_key or frame_no % max(1, args.print_every) == 0:
                emit(payload)
                last_print_key = print_key

            if preview:
                current_flash = flash_label if loop_now <= flash_until else ""
                lines = preview_lines(payload, selected_camera.description, last_attendance_result)
                if not preview.show(
                    frame,
                    lines=lines,
                    detections=detections,
                    progress=decision.progress if decision.state == "candidate" else 0.0,
                    flash_label=current_flash,
                    theme=preview_theme(payload),
                    flash_kind=flash_kind,
                ):
                    break

            if args.max_frames and frame_no >= args.max_frames:
                break
    finally:
        cap.release()
        if preview:
            preview.close()
    return 0


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def build_recognition_payload(
    result: Any,
    index: FaceIndex,
    logger: AttendanceLogger,
    student_cache: dict[str, StudentRecord],
    frame_no: int,
    require_student_resolution: bool = False,
) -> tuple[dict[str, Any], RecognitionObservation]:
    if result.status != "ok" or result.embedding is None:
        payload = {
            "status": result.status,
            "student_id": "",
            "name": "",
            "class_id": "",
            "similarity": 0.0,
            "confidence": 0.0,
            "reason": result.reason,
            "frame": frame_no,
        }
        return payload, RecognitionObservation(status=result.status, reason=result.reason)

    match = index.match(result.embedding)
    payload = {**match.to_payload(), "frame": frame_no, "name": "", "class_id": ""}
    if match.status == "recognized" and match.student_id:
        student, resolver_status, resolver_reason = resolve_student_cached(match.student_id, logger, student_cache)
        payload.update({
            "student_id": student.id,
            "name": student.name,
            "class_id": student.class_id,
            "resolver_status": resolver_status,
        })
        if resolver_reason:
            payload["resolver_reason"] = resolver_reason
        if require_student_resolution and resolver_status == "fallback":
            payload["status"] = "unresolved_student"
            payload["reason"] = resolver_reason or "student_lookup_failed"
    return payload, RecognitionObservation(
        status=payload.get("status", ""),
        student_id=payload.get("student_id", ""),
        similarity=float(payload.get("similarity") or 0.0),
        confidence=float(payload.get("confidence") or 0.0),
        reason=payload.get("reason", ""),
    )


def resolve_student_cached(
    student_id: str,
    logger: AttendanceLogger,
    student_cache: dict[str, StudentRecord],
) -> tuple[StudentRecord, str, str]:
    key = str(student_id)
    if key in student_cache:
        return student_cache[key], "cache", ""
    try:
        student = logger.resolve_student(key)
        student_cache[key] = student
        return student, "db", ""
    except AttendanceLogError as exc:
        student = StudentRecord(id=key, name=f"ID {key}", class_id="")
        student_cache[key] = student
        return student, "fallback", exc.code
    except Exception as exc:
        student = StudentRecord(id=key, name=f"ID {key}", class_id="")
        student_cache[key] = student
        return student, "fallback", exc.__class__.__name__


def handle_confirmed_student(
    student: StudentRecord,
    logger: AttendanceLogger,
    log_attendance: bool,
    station_id: str,
    cooldown_seconds: int,
    dry_run_state: dict[str, str],
    student_cache: dict[str, StudentRecord],
) -> dict[str, Any]:
    if log_attendance:
        try:
            result = logger.mark_toggle(
                student.id,
                station_id=station_id,
                cooldown_seconds=cooldown_seconds,
            )
            student_cache[result.student.id] = result.student
            return result.to_payload()
        except AttendanceLogError as exc:
            return attendance_error_payload(student, "attendance_log_failed", exc.code, exc.detail)
        except Exception as exc:
            return attendance_error_payload(student, "attendance_log_failed", "unexpected_error", exc.__class__.__name__)

    result = dry_run_toggle(student, logger, dry_run_state, student_cache)
    return result.to_payload()


def dry_run_toggle(
    student: StudentRecord,
    logger: AttendanceLogger,
    dry_run_state: dict[str, str],
    student_cache: dict[str, StudentRecord],
) -> AttendanceResult:
    if student.id in dry_run_state:
        event_type = next_presence_event_type({"event_type": dry_run_state[student.id]})
        dry_run_state[student.id] = event_type
        return AttendanceResult(student=student, event_type=event_type, status="dry_run", dry_run=True)
    try:
        result = logger.preview_toggle(student.id)
        student_cache[result.student.id] = result.student
        dry_run_state[result.student.id] = result.event_type
        return result
    except Exception:
        event_type = next_presence_event_type(None)
        dry_run_state[student.id] = event_type
        return AttendanceResult(student=student, event_type=event_type, status="dry_run", dry_run=True)


def attendance_error_payload(student: StudentRecord, status: str, reason: str, detail: str = "") -> dict[str, Any]:
    return {
        **student.to_payload(),
        "event_type": "",
        "attendance_status": "error",
        "attendance_result": status,
        "duplicate": False,
        "dry_run": False,
        "skipped_reason": reason,
        "error_detail": detail,
        "event": None,
    }


def preview_lines(payload: dict[str, Any], camera_description: str, last_attendance_result: dict[str, Any] | None) -> list[str]:
    name = payload.get("name") or payload.get("student_id") or ""
    status = display_status(payload)
    lines = [status]
    if name:
        lines.append(str(name))
    last_label = attendance_result_label(last_attendance_result) if last_attendance_result else ""
    if should_show_last_preview_result(payload, status, last_label):
        lines.append(last_label)
    return lines[:3]


def should_show_last_preview_result(payload: dict[str, Any], status: str, last_label: str) -> bool:
    if not last_label or last_label == status:
        return False
    return str(payload.get("attendance_status") or "") == "wait_leave"


def event_label(event_type: str) -> str:
    return "Приход" if event_type == ARRIVAL else "Уход"


def display_status(payload: dict[str, Any]) -> str:
    result = payload.get("attendance_result")
    if result in {"inserted", "dry_run"}:
        return attendance_result_label(payload)
    if result == "attendance_log_failed":
        return "Ошибка записи"
    if payload.get("status") == "unresolved_student":
        return "Нет в SSO"
    attendance_status = str(payload.get("attendance_status") or "")
    status = str(payload.get("status") or "")
    if attendance_status == "candidate":
        return "Подтверждение"
    if attendance_status == "wait_leave":
        return "Отойдите от камеры"
    if status and status != "recognized":
        return STATUS_LABELS.get(status, "Ожидание")
    return STATUS_LABELS.get(attendance_status, "Ожидание")


def attendance_result_label(payload: dict[str, Any]) -> str:
    event = event_label(str(payload.get("event_type") or ARRIVAL))
    result = str(payload.get("attendance_result") or "")
    if result == "inserted":
        return f"{event} записан"
    if result == "dry_run":
        return f"{event}: тестовый режим"
    if result == "duplicate":
        return f"{event}: повтор"
    if result == "cooldown":
        return f"{event}: пауза"
    return f"{event}: {RESULT_LABELS.get(result, result or 'ожидание')}"


def flash_label_for_attendance(payload: dict[str, Any]) -> str:
    if payload.get("attendance_result") == "dry_run":
        return f"{event_label(str(payload.get('event_type') or ARRIVAL))}: тест"
    return f"{event_label(str(payload.get('event_type') or ARRIVAL))} записан"


def flash_theme_for_attendance(payload: dict[str, Any]) -> str:
    return "departure" if payload.get("event_type") == DEPARTURE else "success"


def preview_theme(payload: dict[str, Any]) -> str:
    result = payload.get("attendance_result")
    if result in {"inserted", "dry_run", "duplicate"}:
        return flash_theme_for_attendance(payload)
    if result in {"attendance_log_failed"} or payload.get("status") == "unresolved_student":
        return "error"
    if payload.get("attendance_status") == "candidate":
        return "candidate"
    if payload.get("attendance_status") == "wait_leave":
        return "wait"
    if payload.get("status") in {"unknown", "ambiguous", "multiple_faces", "low_quality"}:
        return "warning"
    return "idle"


def camera_label(camera_description: str) -> str:
    return str(camera_description).split(" index=", 1)[0].strip() or "камера"


def play_event_sound(enabled: bool, event_type: str) -> None:
    if not enabled:
        return
    try:
        import winsound

        if event_type == DEPARTURE:
            winsound.Beep(1320, 110)
            winsound.Beep(880, 140)
        else:
            winsound.Beep(880, 110)
            winsound.Beep(1320, 140)
    except Exception:
        print("\a", end="", flush=True)


def play_warning_sound(enabled: bool) -> None:
    if not enabled:
        return
    try:
        import winsound

        winsound.Beep(660, 160)
    except Exception:
        print("\a", end="", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
