import numpy as np

from face_module.face_module import FaceDetection
from face_module.preview import PreviewConfig, annotate_frame, compose_preview_frame, normalize_display_lines


def test_normalize_display_lines_keeps_cyrillic_text():
    lines = normalize_display_lines(["Алина Захаренкова", "Приход записан"])

    assert lines == ["Алина Захаренкова", "Приход записан"]
    assert "?" not in "\n".join(lines)


def test_annotate_frame_accepts_cyrillic_overlay_text():
    frame = np.full((160, 240, 3), 120, dtype=np.uint8)

    output = annotate_frame(
        frame,
        ["Подтверждение", "Алина Захаренкова"],
        detections=[],
        progress=0.5,
        flash_label="Приход записан",
        theme="candidate",
        flash_kind="success",
    )

    assert output.shape == frame.shape
    assert output.dtype == frame.dtype
    assert np.any(output != frame)


def test_compose_preview_frame_uses_fixed_canvas_for_common_aspects():
    config = PreviewConfig(width=960, height=540)
    frame_4_3 = np.full((480, 640, 3), 90, dtype=np.uint8)
    frame_16_9 = np.full((720, 1280, 3), 90, dtype=np.uint8)

    output_4_3 = compose_preview_frame(frame_4_3, ["Ожидание"], [], config=config)
    output_16_9 = compose_preview_frame(frame_16_9, ["Ожидание"], [], config=config)

    assert output_4_3.shape == (540, 960, 3)
    assert output_16_9.shape == (540, 960, 3)
    assert output_4_3.dtype == frame_4_3.dtype
    assert output_16_9.dtype == frame_16_9.dtype


def test_compose_preview_frame_scales_face_box_into_letterboxed_canvas():
    config = PreviewConfig(width=960, height=540)
    frame = np.zeros((480, 640, 3), dtype=np.uint8)
    detection = FaceDetection(
        bbox=(160.0, 120.0, 320.0, 240.0),
        landmarks=(220.0, 180.0, 420.0, 180.0, 320.0, 250.0, 250.0, 330.0, 390.0, 330.0),
        score=0.95,
        raw=np.array([160.0, 120.0, 320.0, 240.0, 220.0, 180.0, 420.0, 180.0, 320.0, 250.0, 250.0, 330.0, 390.0, 330.0, 0.95], dtype=np.float32),
    )

    output = compose_preview_frame(frame, [], [detection], config=config, theme="wait")

    assert output.shape == (540, 960, 3)
    assert tuple(output[135, 300]) == (246, 130, 59)
