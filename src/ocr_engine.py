"""
ocr_engine.py
-------------
Text detection and recognition using PaddleOCR.

Each :class:`OCREngine` instance wraps a PaddleOCR model and exposes a single
``detect`` method that returns a list of :class:`TextBox` dataclass instances.

TODO integration points are marked with ``# TODO`` comments below.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from src.utils import get_logger

logger = get_logger(__name__)


# ──────────────────────────────────────────────────────────────
# Data types
# ──────────────────────────────────────────────────────────────

@dataclass
class TextBox:
    """Represents a single detected text region.

    Attributes:
        polygon:    Four corner points of the bounding box as a list of
                    ``[x, y]`` pairs (clockwise from top-left).
        text:       Recognised text string.
        confidence: Recognition confidence score in ``[0, 1]``.
        bbox:       Axis-aligned bounding rectangle ``[x_min, y_min, x_max, y_max]``
                    derived automatically from *polygon*.
    """

    polygon: list[list[float]]
    text: str
    confidence: float
    bbox: list[int] = field(init=False)

    def __post_init__(self) -> None:
        xs = [pt[0] for pt in self.polygon]
        ys = [pt[1] for pt in self.polygon]
        self.bbox = [
            int(min(xs)),
            int(min(ys)),
            int(max(xs)),
            int(max(ys)),
        ]


# ──────────────────────────────────────────────────────────────
# Engine
# ──────────────────────────────────────────────────────────────

class OCREngine:
    """Wrapper around PaddleOCR for text detection and recognition.

    Args:
        language:        PaddleOCR language code (e.g. ``"ch"``, ``"en"``,
                         ``"japan"``).  Defaults to ``"ch"``.
        use_gpu:         Whether to run inference on GPU.  Defaults to
                         ``False``.
        det_db_thresh:   Detection threshold for the DB model.
        rec_batch_num:   Recognition batch size.
        extra_kwargs:    Additional keyword arguments forwarded to
                         ``PaddleOCR()``.

    Example::

        engine = OCREngine(language="ch", use_gpu=False)
        boxes  = engine.detect(image_array)
    """

    def __init__(
        self,
        language: str = "ch",
        use_gpu: bool = False,
        det_db_thresh: float = 0.3,
        rec_batch_num: int = 6,
        **extra_kwargs: Any,
    ) -> None:
        self.language = language
        self.use_gpu = use_gpu
        self.det_db_thresh = det_db_thresh
        self.rec_batch_num = rec_batch_num
        self._extra_kwargs = extra_kwargs
        self._ocr = self._build_model()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_model(self) -> Any:
        """Instantiate PaddleOCR.

        TODO: Adjust PaddleOCR constructor arguments according to your
              environment (e.g. ``show_log=False``, custom ``det_model_dir``,
              ``rec_model_dir``, ``cls_model_dir``).
        """
        try:
            from paddleocr import PaddleOCR  # type: ignore[import]

            logger.info(
                "Loading PaddleOCR (lang=%s, gpu=%s) …", self.language, self.use_gpu
            )
            return PaddleOCR(
                use_angle_cls=True,
                lang=self.language,
                use_gpu=self.use_gpu,
                det_db_thresh=self.det_db_thresh,
                rec_batch_num=self.rec_batch_num,
                show_log=False,
                **self._extra_kwargs,
            )
        except ImportError as exc:
            raise ImportError(
                "PaddleOCR is not installed.  Run: pip install paddleocr paddlepaddle"
            ) from exc

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, image: np.ndarray) -> list[TextBox]:
        """Run OCR on *image* and return all detected text boxes.

        Args:
            image: RGB image as ``np.ndarray`` of shape ``(H, W, 3)``.

        Returns:
            List of :class:`TextBox` instances, one per detected text line.
            Returns an empty list if no text is found.

        TODO: If you need to filter results by language-specific characters
              or confidence threshold, add post-processing here.
        """
        results = self._ocr.ocr(image, cls=True)

        boxes: list[TextBox] = []
        if not results or results[0] is None:
            return boxes

        for line in results[0]:
            polygon, (text, confidence) = line
            boxes.append(
                TextBox(polygon=polygon, text=text, confidence=float(confidence))
            )
            logger.debug("Detected: '%s' (conf=%.2f, bbox=%s)", text, confidence, boxes[-1].bbox)

        logger.info("OCR detected %d text region(s).", len(boxes))
        return boxes
