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

    def _find_bubble_bbox(self, image: np.ndarray, bbox: list[int]) -> tuple[list[int], bool]:
        """Try to find the actual white speech bubble enclosing this text box."""
        import cv2

        try:
            gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
            h, w = gray.shape
            
            box_slice = gray[max(0, bbox[1]):min(h, bbox[3]), max(0, bbox[0]):min(w, bbox[2])]
            if box_slice.size > 0 and np.var(box_slice) > 800:
                # Highly textured: not a classic clean bubble.
                pad_x = int((bbox[2]-bbox[0]) * 0.4)
                pad_y = int((bbox[3]-bbox[1]) * 0.4)
                # Expand horizontally if original text was mostly vertical
                if (bbox[3]-bbox[1]) > (bbox[2]-bbox[0]) * 1.5:
                    pad_x = max(pad_x, int((bbox[3]-bbox[1]) * 0.4))
                return [max(0, bbox[0]-pad_x), max(0, bbox[1]-pad_y), min(w, bbox[2]+pad_x), min(h, bbox[3]+pad_y)], False

            # Binarize to strongly separate black lines from white bubbles
            _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
            
            # Find contours
            contours, _ = cv2.findContours(thresh, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
            
            cx = (bbox[0] + bbox[2]) / 2.0
            cy = (bbox[1] + bbox[3]) / 2.0
            
            text_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
            
            best_bbox = None
            min_area = float('inf')
            
            # Restrict bubble size to max 8 times the text size as a safety measure
            # to avoid replacing the entire page if the "bubble" contour breaks.
            max_valid_area = text_area * 8
            
            for cnt in contours:
                x, y, cw, ch = cv2.boundingRect(cnt)
                area = cw * ch
                
                # Filter: Contour must contain the center of the text,
                # and must be larger than the text, but not ridiculously huge 
                if text_area * 0.8 <= area <= max_valid_area:
                    if x <= cx <= x + cw and y <= cy <= y + ch:
                        if area < min_area:
                            min_area = area
                            best_bbox = [x, y, x + cw, y + ch]
                            
            if best_bbox is not None:
                return best_bbox, True

            # Fallback if no valid bubble contour is found securely
            pad_x = max(10, int((bbox[2]-bbox[0]) * 0.2))
            pad_y = max(10, int((bbox[3]-bbox[1]) * 0.2))
            
            # If the text was vertical, expand horizontally slightly so French text can flow
            if (bbox[3]-bbox[1]) > (bbox[2]-bbox[0]) * 1.5:
                pad_x = max(pad_x, int((bbox[3]-bbox[1]) * 0.6))
                
            return [
                max(0, int(bbox[0] - pad_x)),
                max(0, int(bbox[1] - pad_y)),
                min(w, int(bbox[2] + pad_x)),
                min(h, int(bbox[3] + pad_y))
            ], False
            
        except Exception as e:
            logger.debug("Bubble detection failed: %s", e)
            padding = 15
            return [
                max(0, bbox[0] - padding),
                max(0, bbox[1] - padding),
                min(image.shape[1], bbox[2] + padding),
                min(image.shape[0], bbox[3] + padding)
            ], False

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

        # --- CLUSTERING ---
        # Group text boxes that belong to the same speech bubble using proximity.
        # This is more robust for both horizontal and vertical text direction.
        def boxes_distance(b1: list[int], b2: list[int]) -> float:
            dx = max(0, max(b1[0], b2[0]) - min(b1[2], b2[2]))
            dy = max(0, max(b1[1], b2[1]) - min(b1[3], b2[3]))
            return float((dx**2 + dy**2)**0.5)

        groups: list[list[TextBox]] = []
        for box in confident_boxes:
            matched_group_idx = -1
            char_size_box = min(box.bbox[2] - box.bbox[0], box.bbox[3] - box.bbox[1])
            
            for i, group in enumerate(groups):
                for gbox in group:
                    char_size_gbox = min(gbox.bbox[2] - gbox.bbox[0], gbox.bbox[3] - gbox.bbox[1])
                    char_sz = max(char_size_box, char_size_gbox, 1)
                    dist = boxes_distance(box.bbox, gbox.bbox)
                    
                    # Threshold factor (1.5x char size) to consider boxes part of the same block
                    if dist <= char_sz * 1.5:
                        matched_group_idx = i
                        break
                if matched_group_idx != -1:
                    break
                    
            if matched_group_idx != -1:
                groups[matched_group_idx].append(box)
            else:
                groups.append([box])
                
        grouped_boxes: list[TextBox] = []
        for group in groups:
            # Sort top-to-bottom natively
            group.sort(key=lambda b: b.bbox[1])
            
            merged_text = " ".join(b.text for b in group)
            
            x_min = min(min(pt[0] for pt in b.polygon) for b in group)
            y_min = min(min(pt[1] for pt in b.polygon) for b in group)
            x_max = max(max(pt[0] for pt in b.polygon) for b in group)
            y_max = max(max(pt[1] for pt in b.polygon) for b in group)
            
            merged_poly = [[x_min, y_min], [x_max, y_min], [x_max, y_max], [x_min, y_max]]
            avg_conf = sum(b.confidence for b in group) / len(group)
            
            grouped_boxes.append(TextBox(polygon=merged_poly, text=merged_text, confidence=avg_conf))
                
        logger.info("Grouped into %d contiguous text block(s) for translation.", len(grouped_boxes))

        # ------------------------------------------------------------------
        logger.info("── Step 2 / 4  Translation ─────────────────────────────")
        source_texts = [b.text for b in grouped_boxes]
        translated_texts = self.translator.translate_batch(source_texts)

        for src, tgt in zip(source_texts, translated_texts):
            logger.debug("  '%s'  →  '%s'", src, tgt)

        # ------------------------------------------------------------------
        logger.info("── Step 3 / 4  Inpainting ──────────────────────────────")
        bboxes = [b.bbox for b in grouped_boxes]
        clean_image = self.inpainter.erase(image, bboxes)

        # ------------------------------------------------------------------
        logger.info("── Step 4 / 4  Typesetting ─────────────────────────────")
        
        # Dynamically find full speech bubbles so text is perfectly centered within them.
        # This will also flag if text is OUTSIDE a bubble (acting as SFX or floating text).
        bubble_bboxes = []
        is_bubbles = []
        for b in bboxes:
            bubble_bbox, is_bubble = self._find_bubble_bbox(clean_image, b)
            bubble_bboxes.append(bubble_bbox)
            is_bubbles.append(is_bubble)
            
        # We can pass an extra instruction to the typesetter to render out-of-bubble text differently:
        # namely, rendering it with an aggressive stroke to remain legible on complex art, 
        # using the tight bounding box and slightly smaller padding to not spill.
        result = clean_image.copy()
        for txt, bbx, is_b in zip(translated_texts, bubble_bboxes, is_bubbles):
            # For floating SFX text, we might want to pad it tightly and force stroke to contrast.
            pad = 12 if is_b else 4
            
            # Temporary override Typesetter settings for floating text if needed
            original_stroke_width = self.typesetter.stroke_width
            if not is_b:
                self.typesetter.stroke_width = max(3, self.typesetter.stroke_width * 2)
                
            try:
                result = self.typesetter.render(result, txt, bbx, padding=pad)
            finally:
                if not is_b:
                    self.typesetter.stroke_width = original_stroke_width

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
