"""
pipeline.py
-----------
Master orchestrator for the KomaTranslator workflow.

The :class:`Pipeline` class wires together the four processing modules and
exposes a single ``process`` method that turns one raw manga/manhua page into
a fully translated output image.

Workflow::

    load image
        │
        ▼
    OCREngine.detect()          ── detect text boxes
        │
        ▼
    TranslationEngine.translate_batch()   ── translate all strings at once
        │
        ▼
    Inpainter.erase()           ── remove original text
        │
        ▼
    Typesetter.render_batch()   ── insert translated text
        │
        ▼
    save image

TODO integration points are marked with ``# TODO`` comments below.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from src.inpainter import Inpainter
from src.ocr_engine import OCREngine, TextBox
from src.translation_engine import TranslationEngine
from src.typesetter import Typesetter
from src.utils import get_logger, list_images, load_image, save_image

logger = get_logger(__name__)


class Pipeline:
    """End-to-end translation pipeline.

    Args:
        ocr:         Initialised :class:`~src.ocr_engine.OCREngine`.
        translator:  Initialised :class:`~src.translation_engine.TranslationEngine`.
        inpainter:   Initialised :class:`~src.inpainter.Inpainter`.
        typesetter:  Initialised :class:`~src.typesetter.Typesetter`.
        min_confidence: Minimum OCR confidence score required to process a
                        text box.  Boxes below this threshold are ignored.

    Example::

        pipeline = Pipeline(ocr, translator, inpainter, typesetter)
        result   = pipeline.process(image_array)
    """

    def __init__(
        self,
        ocr: OCREngine,
        translator: TranslationEngine,
        inpainter: Inpainter,
        typesetter: Typesetter,
        min_confidence: float = 0.5,
    ) -> None:
        self.ocr = ocr
        self.translator = translator
        self.inpainter = inpainter
        self.typesetter = typesetter
        self.min_confidence = min_confidence

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def process(self, image: np.ndarray) -> np.ndarray:
        """Translate all text regions in *image*.

        Steps:

        1. Detect text boxes with OCR.
        2. Filter low-confidence detections.
        3. Translate extracted text strings.
        4. Erase original text via inpainting.
        5. Render translated text back onto the image.

        Args:
            image: RGB image as ``np.ndarray`` of shape ``(H, W, 3)``.

        Returns:
            Translated image as ``np.ndarray`` of shape ``(H, W, 3)``.

        TODO: Add a post-processing step to detect and handle special bubble
              shapes (e.g. thought bubbles, sound effects) differently.
        TODO: Consider adding a quality-check step that measures contrast
              between the rendered text and the bubble background.
        """
        logger.info("── Step 1 / 4  OCR detection ───────────────────────────")
        boxes: list[TextBox] = self.ocr.detect(image)

        confident_boxes = [b for b in boxes if b.confidence >= self.min_confidence]
        logger.info(
            "%d / %d box(es) passed confidence threshold (%.2f).",
            len(confident_boxes),
            len(boxes),
            self.min_confidence,
        )

        if not confident_boxes:
            logger.info("No text to translate; returning original image.")
            return image.copy()

        # ------------------------------------------------------------------
        logger.info("── Step 2 / 4  Translation ─────────────────────────────")
        source_texts = [b.text for b in confident_boxes]
        translated_texts = self.translator.translate_batch(source_texts)

        for src, tgt in zip(source_texts, translated_texts):
            logger.debug("  '%s'  →  '%s'", src, tgt)

        # ------------------------------------------------------------------
        logger.info("── Step 3 / 4  Inpainting ──────────────────────────────")
        bboxes = [b.bbox for b in confident_boxes]
        clean_image = self.inpainter.erase(image, bboxes)

        # ------------------------------------------------------------------
        logger.info("── Step 4 / 4  Typesetting ─────────────────────────────")
        result = self.typesetter.render_batch(clean_image, translated_texts, bboxes)

        return result

    def process_file(
        self,
        input_path: str | Path,
        output_path: str | Path,
    ) -> None:
        """Load, process, and save a single image file.

        Args:
            input_path:  Path to the source image.
            output_path: Destination path for the translated image.
        """
        input_path = Path(input_path)
        output_path = Path(output_path)

        logger.info("Processing '%s' …", input_path.name)
        image = load_image(input_path)
        result = self.process(image)
        save_image(result, output_path)
        logger.info("Saved translated image to '%s'.", output_path)

    def process_directory(
        self,
        input_dir: str | Path,
        output_dir: str | Path,
    ) -> None:
        """Process every image in *input_dir* and write results to *output_dir*.

        Args:
            input_dir:  Folder containing source images.
            output_dir: Folder where translated images will be written.
                        Created automatically if it does not exist.

        TODO: Add parallel processing (e.g. ``concurrent.futures.ThreadPoolExecutor``)
              to speed up batch jobs on multi-core machines.
        """
        input_dir = Path(input_dir)
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        image_paths = list_images(input_dir)
        if not image_paths:
            logger.warning("No images found in '%s'.", input_dir)
            return

        logger.info("Found %d image(s) in '%s'.", len(image_paths), input_dir)
        for img_path in image_paths:
            out_path = output_dir / img_path.name
            try:
                self.process_file(img_path, out_path)
            except Exception as exc:  # noqa: BLE001
                logger.error("Failed to process '%s': %s", img_path.name, exc)
