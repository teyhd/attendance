from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

try:
    from .face_module import FaceDetection, require_cv2
except ImportError:
    from face_module import FaceDetection, require_cv2


@dataclass(frozen=True)
class PreviewConfig:
    width: int = 960
    height: int = 540


THEMES = {
    "idle": {"accent": (96, 165, 250), "panel": (15, 23, 42, 190), "fg": "#0f172a", "bg": "#eff6ff"},
    "candidate": {"accent": (34, 197, 94), "panel": (6, 78, 59, 190), "fg": "#064e3b", "bg": "#ecfdf5"},
    "success": {"accent": (22, 163, 74), "panel": (20, 83, 45, 205), "fg": "#064e3b", "bg": "#dcfce7"},
    "departure": {"accent": (14, 165, 233), "panel": (12, 74, 110, 205), "fg": "#075985", "bg": "#e0f2fe"},
    "warning": {"accent": (245, 158, 11), "panel": (120, 53, 15, 200), "fg": "#92400e", "bg": "#fef3c7"},
    "error": {"accent": (239, 68, 68), "panel": (127, 29, 29, 205), "fg": "#991b1b", "bg": "#fee2e2"},
    "wait": {"accent": (59, 130, 246), "panel": (30, 64, 175, 195), "fg": "#1d4ed8", "bg": "#dbeafe"},
}


class PreviewWindow:
    def __init__(self, title: str, config: PreviewConfig | None = None) -> None:
        import tkinter as tk

        self.config = config or PreviewConfig()
        self._closed = False
        self._image = None
        self._tk = tk
        self._root = tk.Tk()
        self._root.title(title)
        self._root.geometry(f"{self.config.width}x{self.config.height}")
        self._root.minsize(self.config.width, self.config.height)
        self._root.maxsize(self.config.width, self.config.height)
        self._root.resizable(False, False)
        self._root.protocol("WM_DELETE_WINDOW", self.close)
        self._root.bind("<q>", lambda _event: self.close())
        self._root.bind("<Escape>", lambda _event: self.close())
        self._label = tk.Label(self._root, bg="#0f172a", borderwidth=0, highlightthickness=0)
        self._label.pack(fill="both", expand=True)

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        self._closed = True
        try:
            self._root.destroy()
        except Exception:
            pass

    def show(
        self,
        frame: np.ndarray,
        lines: Sequence[str] | None = None,
        detections: Iterable[FaceDetection] | None = None,
        progress: float = 0.0,
        flash_label: str = "",
        theme: str = "idle",
        flash_kind: str = "success",
    ) -> bool:
        if self._closed:
            return False
        display_lines = normalize_display_lines(lines or [])
        image = compose_preview_frame(
            frame,
            display_lines,
            detections or [],
            config=self.config,
            progress=progress,
            flash_label=flash_label,
            theme=theme,
            flash_kind=flash_kind,
        )
        rgb = image[:, :, :3][:, :, ::-1]
        height, width = rgb.shape[:2]
        ppm = f"P6\n{width} {height}\n255\n".encode("ascii") + np.ascontiguousarray(rgb).tobytes()
        self._image = self._tk.PhotoImage(data=ppm, format="PPM")
        self._label.configure(image=self._image)
        try:
            self._root.update_idletasks()
            self._root.update()
        except Exception:
            self._closed = True
            return False
        return not self._closed


def compose_preview_frame(
    frame: np.ndarray,
    lines: Sequence[str],
    detections: Iterable[FaceDetection],
    config: PreviewConfig | None = None,
    progress: float = 0.0,
    flash_label: str = "",
    theme: str = "idle",
    flash_kind: str = "success",
) -> np.ndarray:
    config = config or PreviewConfig()
    cv = require_cv2()
    source_height, source_width = frame.shape[:2]
    target_width = int(config.width)
    target_height = int(config.height)
    canvas = np.full((target_height, target_width, 3), (42, 23, 15), dtype=frame.dtype)
    scale = min(target_width / max(1, source_width), target_height / max(1, source_height))
    resized_width = max(1, int(round(source_width * scale)))
    resized_height = max(1, int(round(source_height * scale)))
    offset_x = (target_width - resized_width) // 2
    offset_y = (target_height - resized_height) // 2
    resized = cv.resize(
        frame,
        (resized_width, resized_height),
        interpolation=cv.INTER_AREA if scale < 1.0 else cv.INTER_LINEAR,
    )
    canvas[offset_y:offset_y + resized_height, offset_x:offset_x + resized_width] = resized

    fitted_detections = [
        transform_detection_for_canvas(detection, scale, offset_x, offset_y)
        for detection in detections
    ]
    return annotate_frame(
        canvas,
        lines,
        fitted_detections,
        progress=progress,
        flash_label=flash_label,
        theme=theme,
        flash_kind=flash_kind,
    )


def annotate_frame(
    frame: np.ndarray,
    lines: Sequence[str],
    detections: Iterable[FaceDetection],
    progress: float = 0.0,
    flash_label: str = "",
    theme: str = "idle",
    flash_kind: str = "success",
) -> np.ndarray:
    cv = require_cv2()
    image = frame.copy()
    detection_list = list(detections)
    colors = theme_colors(theme)
    accent_bgr = rgb_to_bgr(colors["accent"])
    progress = float(min(1.0, max(0.0, progress)))

    if progress > 0.0:
        draw_progress_ring(image, detection_list, progress, accent_bgr)
    for detection in detection_list:
        x, y, width, height = [int(round(value)) for value in detection.bbox]
        cv.rectangle(image, (x, y), (x + width, y + height), accent_bgr, 3)

    image = draw_text_panel(image, normalize_display_lines(lines), theme=theme, progress=progress)
    if flash_label:
        image = draw_flash(image, flash_label, flash_kind)
    return image


def draw_progress_ring(
    image: np.ndarray,
    detections: Sequence[FaceDetection],
    progress: float,
    color_bgr: tuple[int, int, int],
) -> None:
    cv = require_cv2()
    height, width = image.shape[:2]
    if detections:
        x, y, box_w, box_h = detections[0].bbox
        center = (int(round(x + box_w / 2)), int(round(y + box_h / 2)))
        min_radius = int(max(box_w, box_h) * 0.72)
    else:
        center = (width // 2, height // 2)
        min_radius = int(min(width, height) * 0.18)
    max_radius = int(max(
        ((center[0] - 0) ** 2 + (center[1] - 0) ** 2) ** 0.5,
        ((center[0] - width) ** 2 + (center[1] - 0) ** 2) ** 0.5,
        ((center[0] - 0) ** 2 + (center[1] - height) ** 2) ** 0.5,
        ((center[0] - width) ** 2 + (center[1] - height) ** 2) ** 0.5,
    ))
    radius = int(max(min_radius, max_radius - (max_radius - min_radius) * progress))
    cv.circle(image, center, radius, color_bgr, 5, cv.LINE_AA)


def draw_text_panel(image: np.ndarray, lines: Sequence[str], theme: str = "idle", progress: float = 0.0) -> np.ndarray:
    if not lines:
        return image
    pil_image = bgr_to_pil_rgba(image)
    from PIL import ImageDraw

    draw = ImageDraw.Draw(pil_image, "RGBA")
    colors = theme_colors(theme)
    title_font = load_font(24, bold=True)
    body_font = load_font(18)
    small_font = load_font(15)
    padding = 14
    gap = 6
    max_panel_width = min(pil_image.width - 24, 520)
    wrapped: list[tuple[str, object]] = []
    for index, line in enumerate(lines[:3]):
        font = title_font if index == 0 else body_font
        wrapped.extend((item, font) for item in wrap_text(draw, str(line), font, max_panel_width - padding * 2))
    text_sizes = [text_size(draw, text, font) for text, font in wrapped]
    panel_width = min(
        max_panel_width,
        max((width for width, _height in text_sizes), default=0) + padding * 2,
    )
    panel_height = sum(height for _width, height in text_sizes) + gap * max(0, len(text_sizes) - 1) + padding * 2
    x0, y0 = 14, 14
    x1, y1 = x0 + panel_width, y0 + panel_height
    draw.rounded_rectangle((x0, y0, x1, y1), radius=12, fill=colors["panel"], outline=(*colors["accent"], 230), width=2)
    y = y0 + padding
    for text, font in wrapped:
        draw.text((x0 + padding, y), text, fill=(255, 255, 255, 245), font=font)
        y += text_size(draw, text, font)[1] + gap
    if progress > 0.0:
        bar_x0 = x0 + padding
        bar_y0 = y1 - 9
        bar_x1 = x1 - padding
        draw.rounded_rectangle((bar_x0, bar_y0, bar_x1, bar_y0 + 4), radius=2, fill=(255, 255, 255, 80))
        draw.rounded_rectangle(
            (bar_x0, bar_y0, bar_x0 + (bar_x1 - bar_x0) * min(1.0, progress), bar_y0 + 4),
            radius=2,
            fill=(*colors["accent"], 245),
        )
    draw_detection_hint(pil_image, small_font, theme)
    return pil_rgba_to_bgr(pil_image)


def draw_flash(image: np.ndarray, label: str, flash_kind: str = "success") -> np.ndarray:
    pil_image = bgr_to_pil_rgba(image)
    from PIL import ImageDraw

    draw = ImageDraw.Draw(pil_image, "RGBA")
    colors = theme_colors(flash_kind)
    accent = colors["accent"]
    width, height = pil_image.size
    draw.rounded_rectangle((8, 8, width - 8, height - 8), radius=16, outline=(*accent, 245), width=8)
    font = load_font(36, bold=True)
    label = str(label)
    text_w, text_h = text_size(draw, label, font)
    pad_x, pad_y = 28, 16
    box = (
        max(16, (width - text_w) // 2 - pad_x),
        max(16, (height - text_h) // 2 - pad_y),
        min(width - 16, (width + text_w) // 2 + pad_x),
        min(height - 16, (height + text_h) // 2 + pad_y),
    )
    draw.rounded_rectangle(box, radius=18, fill=(*accent, 225))
    draw.text(((width - text_w) // 2, (height - text_h) // 2 - 3), label, fill=(255, 255, 255, 255), font=font)
    return pil_rgba_to_bgr(pil_image)


def draw_detection_hint(pil_image: object, font: object, theme: str) -> None:
    # Reserved for future small labels. Keeping text out of the face area makes the kiosk view calmer.
    return None


def normalize_display_lines(lines: Sequence[object]) -> list[str]:
    return [str(line) for line in lines if str(line).strip()]


def transform_detection_for_canvas(
    detection: FaceDetection,
    scale: float,
    offset_x: int,
    offset_y: int,
) -> FaceDetection:
    x, y, width, height = detection.bbox
    bbox = (
        x * scale + offset_x,
        y * scale + offset_y,
        width * scale,
        height * scale,
    )
    landmarks = tuple(
        value * scale + (offset_x if index % 2 == 0 else offset_y)
        for index, value in enumerate(detection.landmarks)
    )
    raw = np.asarray(detection.raw, dtype=np.float32).copy()
    if raw.size >= 4:
        raw[0] = bbox[0]
        raw[1] = bbox[1]
        raw[2] = bbox[2]
        raw[3] = bbox[3]
    for index in range(4, min(14, raw.size), 2):
        raw[index] = raw[index] * scale + offset_x
        if index + 1 < raw.size:
            raw[index + 1] = raw[index + 1] * scale + offset_y
    return FaceDetection(bbox=bbox, landmarks=landmarks, score=detection.score, raw=raw)


def theme_colors(theme: str) -> dict[str, object]:
    return THEMES.get(theme, THEMES["idle"])


def rgb_to_bgr(color: tuple[int, int, int]) -> tuple[int, int, int]:
    return (int(color[2]), int(color[1]), int(color[0]))


def bgr_to_pil_rgba(image: np.ndarray):
    from PIL import Image

    rgb = image[:, :, :3][:, :, ::-1]
    return Image.fromarray(np.ascontiguousarray(rgb)).convert("RGBA")


def pil_rgba_to_bgr(image: object) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB"))
    return np.ascontiguousarray(rgb[:, :, ::-1])


@lru_cache(maxsize=16)
def load_font(size: int, bold: bool = False):
    from PIL import ImageFont

    candidates = font_candidates(bold)
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    for name in ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", "arialbd.ttf" if bold else "arial.ttf"):
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def font_candidates(bold: bool) -> list[Path]:
    windows = Path("C:/Windows/Fonts")
    return [
        windows / ("segoeuib.ttf" if bold else "segoeui.ttf"),
        windows / ("arialbd.ttf" if bold else "arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu") / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"),
    ]


def wrap_text(draw: object, text: str, font: object, max_width: int) -> list[str]:
    if text_size(draw, text, font)[0] <= max_width:
        return [text]
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and text_size(draw, candidate, font)[0] > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines or [text]


def text_size(draw: object, text: str, font: object) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text, font=font)
    return int(bbox[2] - bbox[0]), int(bbox[3] - bbox[1])


def resize_for_preview(image: np.ndarray, max_width: int, max_height: int) -> np.ndarray:
    height, width = image.shape[:2]
    scale = min(max_width / max(1, width), max_height / max(1, height), 1.0)
    if scale >= 1.0:
        return image
    cv = require_cv2()
    return cv.resize(image, (int(width * scale), int(height * scale)), interpolation=cv.INTER_AREA)
