import numpy as np

from face_module.face_module import FaceDetection, FaceQualityConfig, measure_face_quality, normalize_vector


def test_normalize_vector_returns_unit_vector():
    vector = normalize_vector(np.array([3.0, 4.0], dtype=np.float32))
    assert round(float(np.linalg.norm(vector)), 6) == 1.0


def test_quality_rejects_small_face():
    image = np.full((100, 100, 3), 128, dtype=np.uint8)
    detection = FaceDetection(
        bbox=(10.0, 10.0, 20.0, 20.0),
        landmarks=tuple([0.0] * 10),
        score=0.9,
        raw=np.zeros(15, dtype=np.float32),
    )

    quality = measure_face_quality(image, detection, FaceQualityConfig(min_face_size_px=80, min_blur=0))

    assert quality.ok is False
    assert quality.reason == "small_face"
