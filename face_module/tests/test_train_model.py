from pathlib import Path

import numpy as np

from face_module.train_model import BuildConfig, build_face_index
from face_module.face_module import FaceIndex


class FakeEngine:
    def embedding_from_aligned_path(self, image_path):
        name = Path(image_path).name
        if name.startswith("a"):
            return np.array([1.0, 0.0], dtype=np.float32)
        return np.array([0.0, 1.0], dtype=np.float32)


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"fake")


def test_build_face_index_from_aligned_crops(tmp_path):
    dataset = tmp_path / "dataset"
    touch(dataset / "48" / "a1.jpg")
    touch(dataset / "48" / "a2.jpg")
    touch(dataset / "108" / "b1.jpg")
    touch(dataset / "108" / "b2.jpg")
    out = tmp_path / "face_index.npz"

    report = build_face_index(dataset, out, FakeEngine(), BuildConfig(min_samples=2))

    assert out.exists()
    assert report["students"]["48"]["accepted"] == 2
    index = FaceIndex.load(out)
    assert index.student_ids == ["108", "48"]
