"""
typesetter.py
-------------
Renders translated text back into manga/manhua speech bubbles using Pillow.

Features:
- Automatic line-wrapping to fit within the bubble bounding box.
- Auto-sizing: shrinks font until the text fits vertically.
- Optional text outline/stroke for readability on complex backgrounds.

TODO integration points are marked with ``# TODO`` comments below.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from src.utils import get_logger

logger = get_logger(__name__)


class Typesetter:
    """Pillow-based text renderer for speech bubbles.

    Args:
        font_path:    Path to a ``.ttf`` or ``.otf`` font file.
        font_size:    Starting (maximum) font size in points.
        font_color:   RGB text colour as ``(R, G, B)`` tuple.
        line_spacing: Extra pixels between lines.
        max_font_size: Upper bound for auto-size fitting.
        min_font_size: Lower bound; text is clipped if it still doesn't fit.
        stroke_width: Pixel width of the text outline (``0`` = no outline).
        stroke_color: RGB colour of the text outline.

    Example::

        ts = Typesetter(font_path="fonts/NotoSans.ttf", font_size=18)
        result = ts.render(image, "Bonjour !", bbox=[10, 20, 200, 80])
    """

    def __init__(
        self,
        font_path: str | Path = "fonts/default.ttf",
        font_size: int = 18,
        font_color: tuple[int, int, int] = (0, 0, 0),
        line_spacing: int = 6,
        max_font_size: int = 28,
        min_font_size: int = 8,
        stroke_width: int = 0,
        stroke_color: tuple[int, int, int] = (255, 255, 255),
    ) -> None:
        self.font_path = Path(font_path)
        self.font_size = font_size
        self.font_color = font_color
        self.line_spacing = line_spacing
        self.max_font_size = max_font_size
        self.min_font_size = min_font_size
        self.stroke_width = stroke_width
        self.stroke_color = stroke_color

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _load_font(self, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        """Load a TrueType font at *size* points, falling back to the Pillow
        default bitmap font if the font file is missing.

        TODO: Add support for font variants (bold, italic) by accepting a
              ``style`` parameter and loading the corresponding font file.

        Args:
            size: Font size in points.

        Returns:
            A Pillow font object.
        """
        if self.font_path.exists():
            return ImageFont.truetype(str(self.font_path), size)

        logger.warning(
            "Font file not found: '%s'.  Using Pillow default font.", self.font_path
        )
        return ImageFont.load_default()

    def _wrap_text(
        self,
        text: str,
        font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
        max_width: int,
    ) -> list[str]:
        """Break *text* into lines that each fit within *max_width* pixels.

        The algorithm respects existing newline characters and then wraps
        word by word.

        Args:
            text:      Text to wrap (may contain ``\\n``).
            font:      Font used to measure character widths.
            max_width: Maximum line width in pixels.

        Returns:
            List of line strings.
        """
        lines: list[str] = []
        for paragraph in text.split("\n"):
            words = paragraph.split()
            if not words:
                lines.append("")
                continue
            current = words[0]
            for word in words[1:]:
                candidate = f"{current} {word}"
                bbox = font.getbbox(candidate)
                width = bbox[2] - bbox[0]
                if width <= max_width:
                    current = candidate
                else:
                    lines.append(current)
                    current = word
            lines.append(current)
        return lines

    def _text_block_height(
        self,
        lines: list[str],
        font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    ) -> int:
        """Calculate the total pixel height of a wrapped text block.

        Args:
            lines: Wrapped text lines.
            font:  Font used to measure line heights.

        Returns:
            Total height in pixels.
        """
        if not lines:
            return 0
        single_bbox = font.getbbox("Ay")
        line_height = single_bbox[3] - single_bbox[1]
        return line_height * len(lines) + self.line_spacing * (len(lines) - 1)

    def _fit_font(
        self,
        text: str,
        box_width: int,
        box_height: int,
    ) -> tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, list[str]]:
        """Find the largest font size at which the text fits inside the box.

        Args:
            text:       Text to fit.
            box_width:  Available width in pixels.
            box_height: Available height in pixels.

        Returns:
            Tuple of ``(font, wrapped_lines)``.
        """
        size = min(self.font_size, self.max_font_size)
        while size >= self.min_font_size:
            font = self._load_font(size)
            lines = self._wrap_text(text, font, box_width)
            total_h = self._text_block_height(lines, font)
            if total_h <= box_height:
                return font, lines
            size -= 1
        # Last resort: use minimum size even if text overflows
        font = self._load_font(self.min_font_size)
        lines = self._wrap_text(text, font, box_width)
        return font, lines

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def render(
        self,
        image: np.ndarray,
        text: str,
        bbox: list[int],
        padding: int = 4,
        align: str = "center",
    ) -> np.ndarray:
        """Draw *text* centred inside *bbox* on *image*.

        Args:
            image:   RGB image as ``np.ndarray`` of shape ``(H, W, 3)``.
            text:    Translated text to render.
            bbox:    Target bounding box ``[x_min, y_min, x_max, y_max]``.
            padding: Inner padding in pixels applied to each side of *bbox*.
            align:   Horizontal alignment: ``"left"``, ``"center"`` or
                     ``"right"``.

        Returns:
            Image with the text drawn in-place (new array, original untouched).

        TODO: Add support for vertical text layout (tategumi), which is common
              in Japanese manga.
        """
        x_min, y_min, x_max, y_max = bbox
        box_w = x_max - x_min - 2 * padding
        box_h = y_max - y_min - 2 * padding

        if box_w <= 0 or box_h <= 0:
            logger.warning("Bounding box too small to render text; skipping.")
            return image.copy()

        font, lines = self._fit_font(text, box_w, box_h)
        total_h = self._text_block_height(lines, font)

        pil_img = Image.fromarray(image)
        draw = ImageDraw.Draw(pil_img)

        single_bbox = font.getbbox("Ay")
        line_height = single_bbox[3] - single_bbox[1]

        # Vertically centre the text block inside the bounding box
        current_y = y_min + padding + (box_h - total_h) // 2

        for line in lines:
            line_bbox = font.getbbox(line)
            line_w = line_bbox[2] - line_bbox[0]

            if align == "center":
                current_x = x_min + padding + (box_w - line_w) // 2
            elif align == "right":
                current_x = x_max - padding - line_w
            else:  # "left"
                current_x = x_min + padding

            draw_kwargs: dict = {
                "xy": (current_x, current_y),
                "text": line,
                "font": font,
                "fill": self.font_color,
            }
            if self.stroke_width > 0:
                draw_kwargs["stroke_width"] = self.stroke_width
                draw_kwargs["stroke_fill"] = self.stroke_color

            draw.text(**draw_kwargs)
            current_y += line_height + self.line_spacing

        return np.array(pil_img)

    def render_batch(
        self,
        image: np.ndarray,
        texts: list[str],
        bboxes: list[list[int]],
        padding: int = 4,
        align: str = "center",
    ) -> np.ndarray:
        """Render multiple text/bbox pairs onto *image* in sequence.

        Args:
            image:   RGB image.
            texts:   List of translated strings.
            bboxes:  Corresponding bounding boxes.
            padding: Inner padding in pixels.
            align:   Horizontal alignment.

        Returns:
            Modified image with all texts rendered.
        """
        result = image.copy()
        for text, bbox in zip(texts, bboxes):
            result = self.render(result, text, bbox, padding=padding, align=align)
        return result
