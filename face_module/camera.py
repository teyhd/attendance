from __future__ import annotations

from dataclasses import dataclass
from typing import Any

try:
    from .face_module import require_cv2
except ImportError:
    from face_module import require_cv2


VIRTUAL_HINTS = ("virtual", "obs", "eshare", "snap", "manycam")


@dataclass(frozen=True)
class CameraSelection:
    capture: Any
    source: int
    backend: int
    backend_name: str
    label: str
    width: int
    height: int
    brightness: float

    @property
    def description(self) -> str:
        return (
            f"{self.label} index={self.source} backend={self.backend_name} "
            f"frame={self.width}x{self.height} brightness={self.brightness:.1f}"
        )


def parse_camera_spec(value: str | int | None) -> str | int:
    if value is None or str(value).strip() == "":
        return "laptop"
    text = str(value).strip()
    if text.lower() in {"laptop", "internal", "builtin", "built-in", "auto"}:
        return "laptop"
    try:
        return int(text)
    except ValueError:
        return text


def open_camera(camera: str | int | None = "laptop", max_index: int = 3) -> CameraSelection:
    spec = parse_camera_spec(camera)
    if isinstance(spec, int):
        return open_indexed_camera(spec)
    candidates = probe_camera_indices(max_index=max_index)
    if not candidates:
        raise RuntimeError("No working camera found")
    requested = normalize_name(str(spec))
    named = [
        item for item in candidates
        if requested == normalize_name(item.label) or requested in normalize_name(item.label)
    ]
    pool = named or candidates
    selected = sorted(pool, key=camera_score, reverse=True)[0]
    if requested not in {"laptop", "auto", "internal", "builtin", "built-in"}:
        selected = CameraSelection(
            capture=selected.capture,
            source=selected.source,
            backend=selected.backend,
            backend_name=selected.backend_name,
            label=str(spec),
            width=selected.width,
            height=selected.height,
            brightness=selected.brightness,
        )
    return reopen_selection(selected)


def open_indexed_camera(index: int) -> CameraSelection:
    cv = require_cv2()
    for backend_name, backend in preferred_backends():
        cap = cv.VideoCapture(index, backend)
        if not cap.isOpened():
            cap.release()
            continue
        ok, frame = cap.read()
        if ok and frame is not None:
            height, width = frame.shape[:2]
            return CameraSelection(cap, index, backend, backend_name, f"Camera {index}", int(width), int(height), float(frame.mean()))
        cap.release()
    raise RuntimeError(f"Cannot open camera index {index}")


def probe_camera_indices(max_index: int = 3) -> list[CameraSelection]:
    cv = require_cv2()
    candidates: list[CameraSelection] = []
    for backend_name, backend in preferred_backends():
        backend_candidates: list[CameraSelection] = []
        for index in range(max_index):
            cap = cv.VideoCapture(index, backend)
            if not cap.isOpened():
                cap.release()
                continue
            ok, frame = cap.read()
            cap.release()
            if not ok or frame is None:
                continue
            height, width = frame.shape[:2]
            backend_candidates.append(
                CameraSelection(
                    capture=None,
                    source=index,
                    backend=backend,
                    backend_name=backend_name,
                    label=f"Camera {index}",
                    width=int(width),
                    height=int(height),
                    brightness=float(frame.mean()),
                )
            )
        if backend_candidates:
            candidates.extend(backend_candidates)
            break
    return candidates


def reopen_selection(selection: CameraSelection) -> CameraSelection:
    cv = require_cv2()
    cap = cv.VideoCapture(selection.source, selection.backend)
    if not cap.isOpened():
        cap.release()
        raise RuntimeError(f"Cannot reopen camera: {selection.description}")
    ok, frame = cap.read()
    if not ok or frame is None:
        cap.release()
        raise RuntimeError(f"Camera opened but did not return frames: {selection.description}")
    height, width = frame.shape[:2]
    return CameraSelection(
        capture=cap,
        source=selection.source,
        backend=selection.backend,
        backend_name=selection.backend_name,
        label=selection.label,
        width=int(width),
        height=int(height),
        brightness=float(frame.mean()),
    )


def preferred_backends() -> list[tuple[str, int]]:
    cv = require_cv2()
    return [("DSHOW", cv.CAP_DSHOW), ("ANY", cv.CAP_ANY)]


def camera_score(selection: CameraSelection) -> tuple[int, int, int]:
    label = normalize_name(selection.label)
    visible_bonus = 1 if selection.brightness >= 10.0 else -1
    virtual_penalty = -1 if any(hint in label for hint in VIRTUAL_HINTS) else 0
    return (visible_bonus, virtual_penalty, selection.width * selection.height)


def normalize_name(value: str) -> str:
    return " ".join(str(value).strip().lower().split())
