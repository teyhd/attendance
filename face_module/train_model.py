from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
from typing import Any

import numpy as np

try:
    from .face_module import (
        DEFAULT_FACE_THRESHOLD,
        DEFAULT_MARGIN,
        FaceIndex,
        index_meta_path,
        model_default_paths,
        normalize_vector,
        OpenCVFaceEngine,
    )
except ImportError:
    from face_module import (
        DEFAULT_FACE_THRESHOLD,
        DEFAULT_MARGIN,
        FaceIndex,
        index_meta_path,
        model_default_paths,
        normalize_vector,
        OpenCVFaceEngine,
    )


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(frozen=True)
class BuildConfig:
    min_samples: int = 15
    threshold: float = DEFAULT_FACE_THRESHOLD
    margin: float = DEFAULT_MARGIN


def parse_args() -> argparse.Namespace:
    detector_model, recognizer_model = model_default_paths()
    parser = argparse.ArgumentParser(description="Build a face embedding index from collected face crops.")
    parser.add_argument("--dataset", default="face_module/data/dataset", help="Dataset root.")
    parser.add_argument("--out", default="face_module/data/face_index.npz", help="Output NPZ index.")
    parser.add_argument("--detector-model", default=str(detector_model), help="YuNet ONNX model path.")
    parser.add_argument("--recognizer-model", default=str(recognizer_model), help="SFace ONNX model path.")
    parser.add_argument("--min-samples", type=int, default=15, help="Minimum images per student.")
    parser.add_argument("--threshold", type=float, default=DEFAULT_FACE_THRESHOLD, help="Cosine match threshold.")
    parser.add_argument("--margin", type=float, default=DEFAULT_MARGIN, help="Minimum top-vs-second score gap.")
    return parser.parse_args()


def list_images(student_dir: Path) -> list[Path]:
    return sorted(path for path in student_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES)


def build_face_index(
    dataset_dir: str | Path,
    out_path: str | Path,
    engine: OpenCVFaceEngine,
    config: BuildConfig | None = None,
) -> dict[str, Any]:
    cfg = config or BuildConfig()
    dataset = Path(dataset_dir)
    if not dataset.exists():
        raise FileNotFoundError(f"Dataset directory not found: {dataset}")

    student_ids: list[str] = []
    centroids: list[np.ndarray] = []
    all_embeddings: list[np.ndarray] = []
    all_embedding_student_ids: list[str] = []
    report: dict[str, Any] = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "dataset": str(dataset),
        "threshold": cfg.threshold,
        "margin": cfg.margin,
        "min_samples": cfg.min_samples,
        "students": {},
        "skipped_students": {},
        "centroid_similarities": [],
    }

    for student_dir in sorted(path for path in dataset.iterdir() if path.is_dir()):
        student_id = student_dir.name
        accepted: list[np.ndarray] = []
        skipped = 0
        for image_path in list_images(student_dir):
            embedding = engine.embedding_from_aligned_path(image_path)
            if embedding is None:
                skipped += 1
                continue
            accepted.append(normalize_vector(embedding))

        if len(accepted) < cfg.min_samples:
            report["skipped_students"][student_id] = {
                "accepted": len(accepted),
                "required": cfg.min_samples,
                "skipped": skipped,
            }
            continue

        matrix = np.vstack(accepted).astype(np.float32)
        centroid = normalize_vector(np.mean(matrix, axis=0))
        intra = matrix @ centroid
        student_ids.append(student_id)
        centroids.append(centroid)
        all_embeddings.extend(matrix)
        all_embedding_student_ids.extend([student_id] * len(accepted))
        report["students"][student_id] = {
            "accepted": len(accepted),
            "skipped": skipped,
            "intra_class_similarity_mean": round(float(np.mean(intra)), 4),
            "intra_class_similarity_min": round(float(np.min(intra)), 4),
        }

    if not student_ids:
        raise ValueError("No students with enough accepted samples")

    centroid_matrix = np.vstack(centroids).astype(np.float32)
    for left_index, left_id in enumerate(student_ids):
        for right_index in range(left_index + 1, len(student_ids)):
            score = float(centroid_matrix[left_index] @ centroid_matrix[right_index])
            report["centroid_similarities"].append({
                "left": left_id,
                "right": student_ids[right_index],
                "similarity": round(score, 4),
            })

    index = FaceIndex(
        student_ids=student_ids,
        centroids=centroid_matrix,
        threshold=cfg.threshold,
        margin=cfg.margin,
        metadata=report,
    )
    out = Path(out_path)
    index.save(out, embeddings=np.vstack(all_embeddings), embedding_student_ids=all_embedding_student_ids)
    meta = {
        "created_at": report["created_at"],
        "threshold": cfg.threshold,
        "margin": cfg.margin,
        "min_samples": cfg.min_samples,
        "students": report["students"],
        "skipped_students": report["skipped_students"],
        "centroid_similarities": report["centroid_similarities"],
    }
    index_meta_path(out).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    report["out"] = str(out)
    report["meta"] = str(index_meta_path(out))
    return report


def main() -> int:
    args = parse_args()
    engine = OpenCVFaceEngine(args.detector_model, args.recognizer_model)
    report = build_face_index(
        args.dataset,
        args.out,
        engine,
        BuildConfig(min_samples=args.min_samples, threshold=args.threshold, margin=args.margin),
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
