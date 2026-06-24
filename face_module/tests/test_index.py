import numpy as np

from face_module.face_module import FaceIndex


def test_face_index_matches_best_student():
    index = FaceIndex(
        student_ids=["48", "108"],
        centroids=np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32),
        threshold=0.8,
        margin=0.04,
    )

    match = index.match(np.array([0.99, 0.01], dtype=np.float32))

    assert match.status == "recognized"
    assert match.student_id == "48"


def test_face_index_rejects_ambiguous_match():
    index = FaceIndex(
        student_ids=["48", "108"],
        centroids=np.array([[1.0, 0.0], [0.999, 0.04]], dtype=np.float32),
        threshold=0.8,
        margin=0.04,
    )

    match = index.match(np.array([1.0, 0.0], dtype=np.float32))

    assert match.status == "ambiguous"
