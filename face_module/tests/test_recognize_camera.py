from types import SimpleNamespace

import numpy as np

from face_module.attendance_log import AttendanceLogError
from face_module.recognize_camera import (
    GateConfig,
    RecognitionGate,
    RecognitionObservation,
    attendance_result_label,
    build_recognition_payload,
    event_label,
    preview_lines,
)


def recognized(student_id="48"):
    return RecognitionObservation(status="recognized", student_id=student_id, similarity=0.8, confidence=0.5)


def invalid(status="unknown"):
    return RecognitionObservation(status=status, reason=status)


def test_stable_gate_confirms_only_after_time_and_frames():
    gate = RecognitionGate(GateConfig(stable_seconds=1.0, min_stable_frames=3, leave_seconds=0.5))

    assert gate.update(recognized(), 0.0).state == "candidate"
    assert gate.update(recognized(), 0.5).confirmed is False
    decision = gate.update(recognized(), 1.0)

    assert decision.confirmed is True
    assert decision.confirmed_student_id == "48"


def test_same_face_does_not_emit_second_event_until_leave():
    gate = RecognitionGate(GateConfig(stable_seconds=1.0, min_stable_frames=3, leave_seconds=0.5))

    gate.update(recognized(), 0.0)
    gate.update(recognized(), 0.5)
    assert gate.update(recognized(), 1.0).confirmed is True

    decision = gate.update(recognized(), 1.2)

    assert decision.state == "wait_leave"
    assert decision.confirmed is False


def test_reentry_after_leave_can_confirm_next_event():
    gate = RecognitionGate(GateConfig(stable_seconds=1.0, min_stable_frames=3, leave_seconds=0.5))

    gate.update(recognized(), 0.0)
    gate.update(recognized(), 0.5)
    assert gate.update(recognized(), 1.0).confirmed is True
    assert gate.update(invalid("no_face"), 1.2).state == "wait_leave"
    assert gate.update(invalid("no_face"), 1.8).state == "idle"

    assert gate.update(recognized(), 2.0).state == "candidate"
    gate.update(recognized(), 2.5)
    decision = gate.update(recognized(), 3.0)

    assert decision.confirmed is True
    assert decision.confirmed_student_id == "48"


def test_unknown_resets_candidate_window():
    gate = RecognitionGate(GateConfig(stable_seconds=1.0, min_stable_frames=2, leave_seconds=0.5))

    gate.update(recognized(), 0.0)
    gate.update(invalid("unknown"), 0.6)
    decision = gate.update(recognized(), 1.0)

    assert decision.state == "candidate"
    assert decision.confirmed is False
    assert gate.update(recognized(), 1.5).confirmed is False
    assert gate.update(recognized(), 2.0).confirmed is True


def test_identity_switch_starts_new_candidate():
    gate = RecognitionGate(GateConfig(stable_seconds=1.0, min_stable_frames=2, leave_seconds=0.5))

    gate.update(recognized("48"), 0.0)
    decision = gate.update(recognized("66"), 0.5)

    assert decision.state == "candidate"
    assert decision.student_id == "66"
    assert decision.stable_frames == 1


def test_recognition_payload_blocks_unresolved_student_when_logging():
    class FakeMatch:
        status = "recognized"
        student_id = "100"

        def to_payload(self):
            return {
                "status": self.status,
                "student_id": self.student_id,
                "similarity": 0.9,
                "confidence": 0.8,
                "reason": "",
            }

    class FakeIndex:
        def match(self, embedding):
            return FakeMatch()

    class FakeLogger:
        def resolve_student(self, student_id):
            raise AttendanceLogError("student_not_found", f"student_id={student_id}")

    result = SimpleNamespace(status="ok", embedding=np.array([1.0], dtype=np.float32))

    payload, observation = build_recognition_payload(
        result,
        FakeIndex(),
        FakeLogger(),
        {},
        frame_no=1,
        require_student_resolution=True,
    )

    assert payload["status"] == "unresolved_student"
    assert payload["resolver_reason"] == "student_not_found"
    assert observation.recognized is False


def test_event_labels_are_russian():
    assert event_label("arrival") == "Приход"
    assert event_label("departure") == "Уход"


def test_preview_lines_are_user_facing_russian():
    payload = {
        "status": "recognized",
        "attendance_status": "wait_leave",
        "name": "Алина Захаренкова",
        "similarity": 0.9136,
    }
    last = {
        "event_type": "departure",
        "attendance_result": "inserted",
    }

    lines = preview_lines(payload, "HD Webcam index=1 backend=DSHOW frame=640x480 brightness=136.8", last)
    joined = "\n".join(lines)

    assert lines[0] == "Отойдите от камеры"
    assert "Алина Захаренкова" in joined
    assert "Уход записан" in joined
    assert len(lines) <= 3
    for raw_label in ("status:", "name:", "similarity:", "confidence:", "last:", "wait_leave", "Последняя отметка:", "Камера:", "Совпадение"):
        assert raw_label not in joined


def test_preview_lines_do_not_duplicate_current_attendance_result():
    payload = {
        "status": "recognized",
        "attendance_status": "confirmed",
        "attendance_result": "inserted",
        "event_type": "arrival",
        "name": "Алина Захаренкова",
        "similarity": 0.9136,
    }
    last = {
        "event_type": "arrival",
        "attendance_result": "inserted",
    }

    lines = preview_lines(payload, "HD Webcam index=1", last)

    assert lines == ["Приход записан", "Алина Захаренкова"]


def test_attendance_result_label_for_dry_run_is_russian():
    assert attendance_result_label({"event_type": "arrival", "attendance_result": "dry_run"}) == "Приход: тестовый режим"
