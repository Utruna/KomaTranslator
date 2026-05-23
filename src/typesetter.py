"""
typesetter.py
"""

from __future__ import annotations
from pathlib import Path
from typing import Optional
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from src.utils import get_logger
logger = get_logger(__name__)

_SUPERSAMPLE = 2  # render at 2× scale then downscale for crisp antialiasing


class Typesetter:
    def __init__(
        self,
        font_path: str = "src/police/animeace2bb_tt/animeace2_reg.ttf",
        font_size: int = 48,
        font_color: tuple[int, int, int] = (0, 0, 0),
        line_spacing: int = 4,
        max_font_size: int = 200,
        min_font_size: int = 12,
        stroke_width: int = 1,
        stroke_color: tuple[int, int, int] = (255, 255, 255),
    ):
        self.font_path = Path(font_path)
        self.font_size = font_size
        self.max_font_size = max_font_size
        self.min_font_size = min_font_size
        self.line_spacing = line_spacing
        self.font_color = font_color
        self.stroke_width = stroke_width
        self.stroke_color = stroke_color

    def _load_font(self, size: int) -> ImageFont.FreeTypeFont:
        try:
            return ImageFont.truetype(str(self.font_path), size)
        except Exception:
            for path in [
                "C:/Windows/Fonts/arial.ttf",
                "/Library/Fonts/Arial.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ]:
                if Path(path).exists():
                    return ImageFont.truetype(str(path), size)
            logger.warning("Aucune police trouvée, utilisation de la police par défaut de Pillow.")
            return ImageFont.load_default()

    def _fit_text(self, text: str, width: int, height: int, cap: int | None = None) -> tuple[int, str]:
        """Binary search: return (font_size, wrapped_text) fitting in width×height."""
        probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
        hi = min(cap or self.font_size, self.max_font_size)
        lo = self.min_font_size
        best_size = lo
        best_wrapped = self._wrap(text, self._load_font(lo), width)

        while lo <= hi:
            mid = (lo + hi) // 2
            font = self._load_font(mid)
            wrapped = self._wrap(text, font, width)
            bb = probe.multiline_textbbox((0, 0), wrapped, font=font, spacing=self.line_spacing)
            if bb[3] - bb[1] <= height and bb[2] - bb[0] <= width:
                best_size, best_wrapped = mid, wrapped
                lo = mid + 1
            else:
                hi = mid - 1

        return best_size, best_wrapped

    def _draw_text_on(
        self,
        base: Image.Image,
        text: str,
        font: ImageFont.FreeTypeFont,
        cx: int,
        cy: int,
        stroke_width: int,
    ) -> Image.Image:
        """Composite text onto *base* via a transparent RGBA layer."""
        layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        kwargs: dict = {
            "xy": (cx, cy),
            "text": text,
            "font": font,
            "fill": (*self.font_color, 255),
            "align": "center",
            "spacing": self.line_spacing,
            "anchor": "mm",
        }
        if stroke_width > 0:
            kwargs["stroke_width"] = stroke_width
            kwargs["stroke_fill"] = (*self.stroke_color, 255)
        draw.multiline_text(**kwargs)
        return Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB")

    def render(self, image: np.ndarray, text: str, bbox: list[int], padding: int = 6) -> np.ndarray:
        """Render dialogue text inside *bbox* with 2× supersampling."""
        x_min, y_min, x_max, y_max = bbox
        width = x_max - x_min - 2 * padding
        height = y_max - y_min - 2 * padding

        if width <= 0 or height <= 0:
            logger.warning("Bounding box trop petit, skipping.")
            return image.copy()

        font_size, wrapped = self._fit_text(text, width, height)

        S = _SUPERSAMPLE
        pil_img = Image.fromarray(image)
        rw, rh = x_max - x_min, y_max - y_min
        region = pil_img.crop((x_min, y_min, x_max, y_max))
        region_2x = region.resize((rw * S, rh * S), Image.LANCZOS)

        font_2x = self._load_font(font_size * S)
        wrapped_2x = self._wrap(wrapped, font_2x, width * S)
        cx = padding * S + (width * S) // 2
        cy = padding * S + (height * S) // 2

        rendered_2x = self._draw_text_on(region_2x, wrapped_2x, font_2x, cx, cy, self.stroke_width * S)
        region_1x = rendered_2x.resize((rw, rh), Image.LANCZOS)
        pil_img.paste(region_1x, (x_min, y_min))
        return np.array(pil_img)

    def render_sfx(self, image: np.ndarray, text: str, bbox: list[int]) -> np.ndarray:
        """Render a sound-effect / UI notification: maximise font, thick stroke, no padding."""
        padding = 4
        x_min, y_min, x_max, y_max = bbox
        width = x_max - x_min - 2 * padding
        height = y_max - y_min - 2 * padding

        if width <= 0 or height <= 0:
            return image.copy()

        # Start from max_font_size to fill the bbox as much as possible
        font_size, wrapped = self._fit_text(text, width, height, cap=self.max_font_size)
        stroke = max(3, self.stroke_width * 2)

        S = _SUPERSAMPLE
        pil_img = Image.fromarray(image)
        rw, rh = x_max - x_min, y_max - y_min
        region = pil_img.crop((x_min, y_min, x_max, y_max))
        region_2x = region.resize((rw * S, rh * S), Image.LANCZOS)

        font_2x = self._load_font(font_size * S)
        wrapped_2x = self._wrap(wrapped, font_2x, width * S)
        cx = padding * S + (width * S) // 2
        cy = padding * S + (height * S) // 2

        rendered_2x = self._draw_text_on(region_2x, wrapped_2x, font_2x, cx, cy, stroke * S)
        region_1x = rendered_2x.resize((rw, rh), Image.LANCZOS)
        pil_img.paste(region_1x, (x_min, y_min))
        return np.array(pil_img)

    def _wrap(self, text: str, font: ImageFont.FreeTypeFont, max_width: int) -> str:
        lines = []
        for line in text.split("\n"):
            words = line.split()
            if not words:
                lines.append("")
                continue
            current = words[0]
            for word in words[1:]:
                test = current + (" " + word if current else word)
                w = font.getbbox(test)[2] - font.getbbox(test)[0]
                if w <= max_width:
                    current = test
                else:
                    lines.append(current)
                    current = word
            lines.append(current)
        return "\n".join(lines)
