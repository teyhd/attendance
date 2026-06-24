from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import time

try:
    from .camera import open_camera
    from .face_module import OpenCVFaceEngine, metadata_line, model_default_paths
    from .preview import PreviewWindow
except ImportError:
    from camera import open_camera
    from face_module import OpenCVFaceEngine, metadata_line, model_default_paths
    from preview import PreviewWindow


def parse_args() -> argparse.Namespace:
    detector_model, recognizer_model = model_default_paths()
    parser = argparse.ArgumentParser(description="Collect aligned face crops from a laptop camera.")
    parser.add_argument("--student-id", required=True, help="SSO student id.")
    parser.add_argument("--samples", type=int, default=40, help="Number of accepted samples.")
    parser.add_argument("--camera", default="HD Webcam", help="Camera selector: 'HD Webcam', 'laptop', or numeric index.")
    parser.add_argument("--dataset", default="face_module/data/dataset", help="Dataset root directory.")
    parser.add_argument("--detector-model", default=str(detector_model), help="YuNet ONNX model path.")
    parser.add_argument("--recognizer-model", default=str(recognizer_model), help="SFace ONNX model path.")
    parser.add_argument("--detector-threshold", type=float, default=0.85, help="YuNet score threshold.")
    parser.add_argument("--no-preview", action="store_true", help="Disable preview window.")
    parser.add_argument("--delay", type=float, default=0.2, help="Delay between accepted samples in seconds.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    student_id = str(args.student_id)
    cv = __import__("cv2")
    engine = OpenCVFaceEngine(
        args.detector_model,
        args.recognizer_model,
        detector_score_threshold=args.detector_threshold,
    )
    target_dir = Path(args.dataset) / student_id
    target_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = target_dir / "metadata.jsonl"

    selected_camera = open_camera(args.camera)
    cap = selected_camera.capture
    print(f"camera: {selected_camera.description}", flush=True)
    preview = None if args.no_preview else PreviewWindow(f"Collect dataset: student {student_id}")
    accepted = 0
    try:
        while accepted < args.samples:
            ok, frame = cap.read()
            if not ok:
                print("Camera frame read failed", flush=True)
                time.sleep(0.2)
                continue
            result = engine.extract_single_embedding(frame)
            lines = [
                f"student {student_id}",
                f"saved {accepted}/{args.samples}",
                f"{result.status} {result.reason}".strip(),
                selected_camera.description,
            ]
            if result.status == "ok" and result.aligned_image is not None:
                accepted += 1
                stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
                image_path = target_dir / f"{stamp}_{accepted:03d}.jpg"
                cv.imwrite(str(image_path), result.aligned_image)
                with metadata_path.open("a", encoding="utf-8") as stream:
                    stream.write(metadata_line({
                        "student_id": student_id,
                        "file": image_path.name,
                        "camera": selected_camera.description,
                        "status": result.status,
                        "detection_count": result.detection_count,
                        "quality": result.quality.to_metadata() if result.quality else {},
                    }) + "\n")
                lines[1] = f"saved {accepted}/{args.samples}"
                lines[2] = "saved"
                print(f"saved {accepted}/{args.samples}: {image_path}", flush=True)
                time.sleep(max(0.0, args.delay))
            else:
                print(f"skip: {result.status} {result.reason}", flush=True)
            if preview:
                detections = [result.detection] if result.detection else []
                if not preview.show(frame, lines=lines, detections=detections):
                    break
    finally:
        cap.release()
        if preview:
            preview.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
