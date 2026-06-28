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

import re
from pathlib import Path
from typing import Literal

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
        min_confidence: float = 0.4,
        cluster_threshold: float = 0.8,
        max_cluster_distance_px: int = 80,
        bubble_grouping_threshold: float = 0.8,
    ) -> None:
        self.ocr = ocr
        self.translator = translator
        self.inpainter = inpainter
        self.typesetter = typesetter
        self.min_confidence = min_confidence
        self.cluster_threshold = cluster_threshold
        self.max_cluster_distance_px = max_cluster_distance_px
        # Level-2 proximity multiplier: dist <= char_sz * threshold.  Lower
        # values keep distinct bubbles separate; raise only if horizontal
        # fragments are under-grouped.
        self.bubble_grouping_threshold = bubble_grouping_threshold

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @staticmethod
    def _classify_text(text: str, is_bubble: bool) -> Literal["dialogue", "sfx", "skip"]:
        """Classify out-of-bubble text to route translation and rendering.

        - dialogue : normal translation + render()
        - sfx      : short SFX/UI text → translate_sfx() + render_sfx()
        - skip     : pure artistic brushstroke / illegible → leave untouched
        """
        if is_bubble:
            return "dialogue"
        stripped = text.strip()
        has_sentence = bool(re.search(r'[。！？，、；：]', stripped))
        # Very short + no sentence markers → likely pure artistic SFX, leave it
        if len(stripped) <= 2 and not has_sentence:
            return "skip"
        # Game/cultivation UI: short formula with number operators
        if re.search(r'[+\-]\s*\d', stripped) and len(stripped) <= 10:
            return "sfx"
        # Short isolated fragment without sentence structure → SFX
        if len(stripped) <= 5 and not has_sentence:
            return "sfx"
        return "dialogue"

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
        def _gap_distance(b1: list[int], b2: list[int]) -> float:
            """Euclidean distance between the nearest edges of two bboxes."""
            dx = max(0, max(b1[0], b2[0]) - min(b1[2], b2[2]))
            dy = max(0, max(b1[1], b2[1]) - min(b1[3], b2[3]))
            return float((dx**2 + dy**2) ** 0.5)

        def _same_column(b1: list[int], b2: list[int]) -> bool:
            """Level 1: strict vertical alignment — horizontal overlap + close rows."""
            overlap_x = min(b1[2], b2[2]) - max(b1[0], b2[0])
            if overlap_x <= 0:
                return False
            gap_y = max(0, max(b1[1], b2[1]) - min(b1[3], b2[3]))
            char_height = max(b1[3] - b1[1], b2[3] - b2[1], 1)
            return gap_y <= char_height * 2.0

        def _close_proximity(b1: list[int], b2: list[int]) -> bool:
            """Level 2: tight Euclidean fallback for fragmented horizontal text."""
            char_sz = max(
                min(b1[2] - b1[0], b1[3] - b1[1]),
                min(b2[2] - b2[0], b2[3] - b2[1]),
                1,
            )
            return _gap_distance(b1, b2) <= char_sz * self.bubble_grouping_threshold

        groups: list[list[TextBox]] = []
        for box in confident_boxes:
            matched_group_idx = -1
            for i, group in enumerate(groups):
                for gbox in group:
                    if _same_column(box.bbox, gbox.bbox) or _close_proximity(box.bbox, gbox.bbox):
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
            group.sort(key=lambda b: b.bbox[1])
            merged_text = " ".join(b.text for b in group)
            x_min = min(min(pt[0] for pt in b.polygon) for b in group)
            y_min = min(min(pt[1] for pt in b.polygon) for b in group)
            x_max = max(max(pt[0] for pt in b.polygon) for b in group)
            y_max = max(max(pt[1] for pt in b.polygon) for b in group)
            merged_poly = [[x_min, y_min], [x_max, y_min], [x_max, y_max], [x_min, y_max]]
            avg_conf = sum(b.confidence for b in group) / len(group)
            grouped_boxes.append(TextBox(polygon=merged_poly, text=merged_text, confidence=avg_conf))

        def _iou(a: list[int], b: list[int]) -> float:
            ix1 = max(a[0], b[0])
            iy1 = max(a[1], b[1])
            ix2 = min(a[2], b[2])
            iy2 = min(a[3], b[3])
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            if inter == 0:
                return 0.0
            area_a = (a[2] - a[0]) * (a[3] - a[1])
            area_b = (b[2] - b[0]) * (b[3] - b[1])
            return inter / (area_a + area_b - inter)

        # TODO: make IOU_DEDUP_THRESHOLD configurable via config.yaml (pipeline section)
        IOU_DEDUP_THRESHOLD = 0.5
        deduplicated: list[TextBox] = []
        for candidate in grouped_boxes:
            duplicate = False
            for kept in deduplicated:
                if _iou(candidate.bbox, kept.bbox) >= IOU_DEDUP_THRESHOLD:
                    if len(candidate.text) > len(kept.text):
                        deduplicated.remove(kept)
                        deduplicated.append(candidate)
                    duplicate = True
                    break
            if not duplicate:
                deduplicated.append(candidate)
        removed = len(grouped_boxes) - len(deduplicated)
        if removed:
            logger.info("Deduplicated %d overlapping box(es).", removed)
        grouped_boxes = deduplicated

        logger.info("Grouped into %d contiguous text block(s) for translation.", len(grouped_boxes))

        # ------------------------------------------------------------------
        logger.info("── Step 2 / 4  Translation ─────────────────────────────")

        # Pre-classify each group before translating so we can route to the right prompt
        # and decide whether to inpaint at all (skip = leave original art intact).
        bboxes_all = [b.bbox for b in grouped_boxes]
        bubble_bboxes_pre = []
        is_bubbles_pre = []
        for b in bboxes_all:
            bb, is_b = self._find_bubble_bbox(image, b)
            bubble_bboxes_pre.append(bb)
            is_bubbles_pre.append(is_b)

        kinds: list[str] = [
            self._classify_text(box.text, is_b)
            for box, is_b in zip(grouped_boxes, is_bubbles_pre)
        ]

        # Boxes classified as "skip" are left completely untouched (original art preserved).
        active_indices = [i for i, k in enumerate(kinds) if k != "skip"]
        skipped = len(grouped_boxes) - len(active_indices)
        if skipped:
            logger.info("Skipping %d pure-art SFX box(es) (no inpainting, no translation).", skipped)

        active_boxes   = [grouped_boxes[i]      for i in active_indices]
        active_bboxes  = [bboxes_all[i]         for i in active_indices]
        active_bubbles = [bubble_bboxes_pre[i]  for i in active_indices]
        active_is_b    = [is_bubbles_pre[i]     for i in active_indices]
        active_kinds   = [kinds[i]              for i in active_indices]

        translated_texts: list[str] = []
        for box, kind in zip(active_boxes, active_kinds):
            src = box.text
            if kind == "sfx":
                tgt = self.translator.translate_sfx(src)
            else:
                tgt = self.translator.translate(src)
            logger.debug("  [%s] '%s'  →  '%s'", kind, src, tgt)
            translated_texts.append(tgt)

        # ------------------------------------------------------------------
        logger.info("── Step 3 / 4  Inpainting ──────────────────────────────")
        clean_image = self.inpainter.erase(image, active_bboxes, textbox_list=active_boxes)

        # ------------------------------------------------------------------
        logger.info("── Step 4 / 4  Typesetting ─────────────────────────────")

        # Re-detect bubble bboxes on the clean (inpainted) image for accurate centering.
        bubble_bboxes: list[list[int]] = []
        is_bubbles: list[bool] = []
        for b in active_bboxes:
            bb, is_b = self._find_bubble_bbox(clean_image, b)
            bubble_bboxes.append(bb)
            is_bubbles.append(is_b)

        result = clean_image.copy()
        for txt, bbx, is_b, kind in zip(translated_texts, bubble_bboxes, is_bubbles, active_kinds):
            if kind == "sfx":
                result = self.typesetter.render_sfx(result, txt, bbx)
            else:
                pad = 12 if is_b else 6
                result = self.typesetter.render(result, txt, bbx, padding=pad)

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
