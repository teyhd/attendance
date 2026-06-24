from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
from pathlib import Path
from typing import Any

import numpy as np


DEFAULT_FACE_THRESHOLD = 0.363
DEFAULT_MARGIN = 0.04


def require_cv2() -> Any:
    try:
        import cv2 as cv
    except ImportError as exc:
        raise RuntimeError(
            "OpenCV is required. Install: python -m pip install -r face_module/requirements.txt"
        ) from exc
    return cv


def normalize_vector(vector: np.ndarray) -> np.ndarray:
    arr = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(arr))
    return arr if norm <= 0.0 else arr / norm


def technical_confidence(score: float, threshold: float = DEFAULT_FACE_THRESHOLD) -> float:
    if score <= threshold:
        return 0.0
    if threshold >= 1.0:
        return 1.0
    return round(float(min(1.0, max(0.0, (score - threshold) / (1.0 - threshold)))), 4)


def index_meta_path(index_path: str | Path) -> Path:
    path = Path(index_path)
    return path.with_name(f"{path.stem}_meta.json")


def model_default_paths(base_dir: str | Path | None = None) -> tuple[Path, Path]:
    root = Path(base_dir) if base_dir else Path(__file__).resolve().parent
    return (
        root / "models" / "face_detection_yunet_2023mar.onnx",
        root / "models" / "face_recognition_sface_2021dec.onnx",
    )


def metadata_line(data: dict[str, Any]) -> str:
    return json.dumps(
        {"created_at": datetime.now().isoformat(timespec="seconds"), **data},
        ensure_ascii=False,
        sort_keys=True,
    )


@dataclass(frozen=True)
class FaceQualityConfig:
    min_face_size_px: int = 70
    min_blur: float = 30.0
    min_brightness: float = 25.0
    max_brightness: float = 245.0
    min_detector_score: float = 0.85


@dataclass(frozen=True)
class FaceDetection:
    bbox: tuple[float, float, float, float]
    landmarks: tuple[float, ...]
    score: float
    raw: np.ndarray

    @property
    def alignment_box(self) -> np.ndarray:
        return np.asarray(self.raw[:14], dtype=np.float32)

    @property
    def face_size(self) -> float:
        return min(float(self.bbox[2]), float(self.bbox[3]))


@dataclass(frozen=True)
class FaceQuality:
    face_size_px: float
    blur: float
    brightness: float
    detector_score: float
    ok: bool
    reason: str = "ok"

    def to_metadata(self) -> dict[str, Any]:
        return {
            "face_size_px": round(float(self.face_size_px), 2),
            "blur": round(float(self.blur), 2),
            "brightness": round(float(self.brightness), 2),
            "detector_score": round(float(self.detector_score), 4),
            "ok": bool(self.ok),
            "reason": self.reason,
        }


@dataclass(frozen=True)
class EmbeddingResult:
    status: str
    embedding: np.ndarray | None = None
    detection: FaceDetection | None = None
    quality: FaceQuality | None = None
    detection_count: int = 0
    aligned_image: np.ndarray | None = None
    reason: str = ""


@dataclass(frozen=True)
class FaceMatch:
    status: str
    student_id: str | None = None
    similarity: float = 0.0
    second_similarity: float | None = None
    margin: float | None = None
    confidence: float = 0.0
    reason: str = ""

    def to_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "student_id": self.student_id or "",
            "similarity": round(float(self.similarity), 4),
            "second_similarity": (
                round(float(self.second_similarity), 4)
                if self.second_similarity is not None
                else None
            ),
            "margin": round(float(self.margin), 4) if self.margin is not None else None,
            "confidence": round(float(self.confidence), 4),
            "reason": self.reason,
        }


class FaceIndex:
    def __init__(
        self,
        student_ids: list[str],
        centroids: np.ndarray,
        threshold: float = DEFAULT_FACE_THRESHOLD,
        margin: float = DEFAULT_MARGIN,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.student_ids = [str(student_id) for student_id in student_ids]
        self.centroids = np.asarray(centroids, dtype=np.float32)
        if self.centroids.ndim != 2:
            raise ValueError("centroids must be a 2D array")
        if len(self.student_ids) != self.centroids.shape[0]:
            raise ValueError("student_ids length must match centroids rows")
        self.centroids = np.vstack([normalize_vector(row) for row in self.centroids])
        self.threshold = float(threshold)
        self.margin = float(margin)
        self.metadata = metadata or {}

    def match(self, embedding: np.ndarray) -> FaceMatch:
        if not self.student_ids:
            return FaceMatch(status="unknown", reason="empty_index")
        normalized = normalize_vector(embedding)
        scores = self.centroids @ normalized
        order = np.argsort(-scores)
        best_index = int(order[0])
        best_score = float(scores[best_index])
        second_score = float(scores[int(order[1])]) if len(order) > 1 else None
        gap = best_score - second_score if second_score is not None else None
        confidence = technical_confidence(best_score, self.threshold)

        if best_score < self.threshold:
            return FaceMatch(
                status="unknown",
                similarity=best_score,
                second_similarity=second_score,
                margin=gap,
                confidence=0.0,
                reason="below_threshold",
            )
        if gap is not None and gap < self.margin:
            return FaceMatch(
                status="ambiguous",
                similarity=best_score,
                second_similarity=second_score,
                margin=gap,
                confidence=confidence,
                reason="low_margin",
            )
        return FaceMatch(
            status="recognized",
            student_id=self.student_ids[best_index],
            similarity=best_score,
            second_similarity=second_score,
            margin=gap,
            confidence=confidence,
        )

    def save(self, path: str | Path, embeddings: np.ndarray | None = None, embedding_student_ids: list[str] | None = None) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, Any] = {
            "student_ids": np.asarray(self.student_ids),
            "centroids": np.asarray(self.centroids, dtype=np.float32),
            "threshold": np.asarray([self.threshold], dtype=np.float32),
            "margin": np.asarray([self.margin], dtype=np.float32),
        }
        if embeddings is not None:
            payload["embeddings"] = np.asarray(embeddings, dtype=np.float32)
            payload["embedding_student_ids"] = np.asarray(embedding_student_ids or [])
        np.savez_compressed(target, **payload)

    @classmethod
    def load(cls, path: str | Path) -> "FaceIndex":
        source = Path(path)
        data = np.load(source, allow_pickle=False)
        meta_file = index_meta_path(source)
        metadata: dict[str, Any] = {}
        if meta_file.exists():
            metadata = json.loads(meta_file.read_text(encoding="utf-8"))
        threshold = float(metadata.get("threshold", float(data.get("threshold", [DEFAULT_FACE_THRESHOLD])[0])))
        margin = float(metadata.get("margin", float(data.get("margin", [DEFAULT_MARGIN])[0])))
        return cls(
            student_ids=[str(value) for value in data["student_ids"].astype(str).tolist()],
            centroids=np.asarray(data["centroids"], dtype=np.float32),
            threshold=threshold,
            margin=margin,
            metadata=metadata,
        )


class OpenCVFaceEngine:
    def __init__(
        self,
        detector_model_path: str | Path,
        recognizer_model_path: str | Path,
        detector_score_threshold: float = 0.85,
        nms_threshold: float = 0.3,
        top_k: int = 5000,
        quality: FaceQualityConfig | None = None,
    ) -> None:
        self.detector_model_path = Path(detector_model_path)
        self.recognizer_model_path = Path(recognizer_model_path)
        self.detector_score_threshold = detector_score_threshold
        self.nms_threshold = nms_threshold
        self.top_k = top_k
        self.quality_config = quality or FaceQualityConfig(min_detector_score=detector_score_threshold)
        self._detector: Any | None = None
        self._recognizer: Any | None = None

    def _ensure_loaded(self) -> None:
        if self._detector is not None and self._recognizer is not None:
            return
        if not self.detector_model_path.exists():
            raise FileNotFoundError(f"Detector model not found: {self.detector_model_path}")
        if not self.recognizer_model_path.exists():
            raise FileNotFoundError(f"Recognizer model not found: {self.recognizer_model_path}")
        cv = require_cv2()
        self._detector = cv.FaceDetectorYN.create(
            str(self.detector_model_path),
            "",
            (320, 320),
            float(self.detector_score_threshold),
            float(self.nms_threshold),
            int(self.top_k),
        )
        self._recognizer = cv.FaceRecognizerSF.create(str(self.recognizer_model_path), "")

    def detect_faces(self, image: np.ndarray) -> list[FaceDetection]:
        self._ensure_loaded()
        if image is None or image.size == 0:
            return []
        height, width = image.shape[:2]
        self._detector.setInputSize((int(width), int(height)))
        _, faces = self._detector.detect(image)
        if faces is None:
            return []
        rows = np.asarray(faces, dtype=np.float32).reshape(-1, 15)
        return sorted(
            [
                FaceDetection(
                    bbox=tuple(float(value) for value in row[:4]),
                    landmarks=tuple(float(value) for value in row[4:14]),
                    score=float(row[14]),
                    raw=row.copy(),
                )
                for row in rows
            ],
            key=lambda item: item.score,
            reverse=True,
        )

    def measure_quality(self, image: np.ndarray, detection: FaceDetection) -> FaceQuality:
        return measure_face_quality(image, detection, self.quality_config)

    def align_face(self, image: np.ndarray, detection: FaceDetection) -> np.ndarray:
        self._ensure_loaded()
        return self._recognizer.alignCrop(image, detection.alignment_box)

    def embedding_from_aligned(self, aligned_image: np.ndarray) -> np.ndarray:
        self._ensure_loaded()
        return normalize_vector(np.asarray(self._recognizer.feature(aligned_image), dtype=np.float32))

    def embedding_from_aligned_path(self, image_path: str | Path) -> np.ndarray | None:
        cv = require_cv2()
        image = cv.imread(str(image_path))
        if image is None:
            return None
        return self.embedding_from_aligned(image)

    def extract_single_embedding(self, image: np.ndarray) -> EmbeddingResult:
        detections = self.detect_faces(image)
        if not detections:
            return EmbeddingResult(status="no_face", detection_count=0, reason="no_face")
        if len(detections) > 1:
            return EmbeddingResult(status="multiple_faces", detection_count=len(detections), reason="multiple_faces")
        detection = detections[0]
        quality = self.measure_quality(image, detection)
        if not quality.ok:
            return EmbeddingResult(
                status="low_quality",
                detection=detection,
                quality=quality,
                detection_count=1,
                reason=quality.reason,
            )
        aligned = self.align_face(image, detection)
        return EmbeddingResult(
            status="ok",
            embedding=self.embedding_from_aligned(aligned),
            detection=detection,
            quality=quality,
            detection_count=1,
            aligned_image=aligned,
        )


def measure_face_quality(image: np.ndarray, detection: FaceDetection, config: FaceQualityConfig) -> FaceQuality:
    crop = crop_detection(image, detection)
    if crop.size == 0:
        return FaceQuality(0.0, 0.0, 0.0, detection.score, False, "invalid_bbox")
    gray = to_gray(crop)
    brightness = float(np.mean(gray))
    blur = blur_score(gray)
    face_size = detection.face_size
    if detection.score < config.min_detector_score:
        reason = "low_detector_score"
    elif face_size < config.min_face_size_px:
        reason = "small_face"
    elif brightness < config.min_brightness:
        reason = "underexposed"
    elif brightness > config.max_brightness:
        reason = "overexposed"
    elif blur < config.min_blur:
        reason = "blurred"
    else:
        reason = "ok"
    return FaceQuality(face_size, blur, brightness, detection.score, reason == "ok", reason)


def crop_detection(image: np.ndarray, detection: FaceDetection) -> np.ndarray:
    x, y, width, height = detection.bbox
    img_h, img_w = image.shape[:2]
    left = max(0, int(round(x)))
    top = max(0, int(round(y)))
    right = min(img_w, int(round(x + width)))
    bottom = min(img_h, int(round(y + height)))
    if right <= left or bottom <= top:
        return np.asarray([], dtype=image.dtype)
    return image[top:bottom, left:right]


def to_gray(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return image
    return np.mean(image[:, :, :3], axis=2).astype(np.uint8)


def blur_score(gray_image: np.ndarray) -> float:
    cv = require_cv2()
    return float(cv.Laplacian(gray_image, cv.CV_64F).var())
