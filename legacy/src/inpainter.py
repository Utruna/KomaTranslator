"""
inpainter.py
------------
Erases original text from manga/manhua panels.

Two strategies are supported and selected via ``config.yaml``:

* ``"lama"``   – deep-learning inpainting using the LaMa model (best quality).
* ``"opencv"`` – classical inpainting (Telea or Navier-Stokes); no GPU needed.

TODO integration points are marked with ``# TODO`` comments below.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import cv2
import numpy as np

from src.bubble_segmentation import classify_text_region, SegmentationResult
from src.utils import get_logger

logger = get_logger(__name__)

InpaintMethod = Literal["lama", "opencv"]


class Inpainter:
    """Text-erasing engine.

    Args:
        method:           ``"lama"`` or ``"opencv"``.
        model_path:       Path to the LaMa model directory (only used when
                          *method* is ``"lama"``).
        device:           ``"cpu"`` or ``"cuda"`` (LaMa only).
        opencv_method:    OpenCV algorithm to use when *method* is
                          ``"opencv"``: ``"telea"`` or ``"ns"``.
        dilation_kernel:  Size of the dilation kernel applied to text masks
                          before inpainting (enlarges the erased area to
                          remove any residual text border pixels).

    Example::

        inpainter = Inpainter(method="opencv")
        clean_img = inpainter.erase(image, mask)
    """

    def __init__(
        self,
        method: InpaintMethod = "lama",
        model_path: str | Path = "models/lama",
        device: str = "cpu",
        opencv_method: str = "telea",
        dilation_kernel: int = 5,
    ) -> None:
        self.method = method
        self.model_path = Path(model_path)
        self.device = device
        self.opencv_method = opencv_method.lower()
        self.dilation_kernel = dilation_kernel

        # _effective_method may differ from self.method when LaMa is not yet
        # available and we fall back to OpenCV at runtime.
        self._effective_method: InpaintMethod = method
        self._model = self._build_model() if method == "lama" else None

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_model(self) -> object:
        """Load the LaMa inpainting model via simple-lama-inpainting.

        model_path is kept for API compatibility but is unused here —
        simple-lama-inpainting downloads the big-lama checkpoint automatically
        via huggingface_hub on first use.
        """
        try:
            from simple_lama_inpainting import SimpleLama  # late import
        except ImportError:
            logger.warning(
                "simple-lama-inpainting is not installed. "
                "Run: pip install simple-lama-inpainting  "
                "Falling back to OpenCV inpainting."
            )
            self._effective_method = "opencv"
            return None

        try:
            import torch
            # simple-lama-inpainting may ignore the device kwarg and let PyTorch
            # auto-select; force CPU explicitly before model construction.
            device = torch.device(self.device)
            model = SimpleLama(device=device)
            logger.info("LaMa model loaded successfully on device '%s'.", self.device)
            return model
        except Exception as exc:
            logger.warning(
                "LaMa model failed to load (%s). Falling back to OpenCV inpainting.",
                exc,
            )
            self._effective_method = "opencv"
            return None

    def _build_mask(
        self,
        image_shape: tuple[int, int],
        bboxes: list[list[int]],
        segmentation_data: dict[int, SegmentationResult] | None = None,
    ) -> np.ndarray:
        """Create a binary inpainting mask from axis-aligned bounding boxes or segmentation data.

        Args:
            image_shape: ``(height, width)`` of the target image.
            bboxes:      List of ``[x_min, y_min, x_max, y_max]`` rectangles.
            segmentation_data: Optional dict of SegmentationResult objects from
                             bubble_segmentation. If provided, uses intelligent masks.

        Returns:
            ``uint8`` mask of shape ``(H, W)`` where ``255`` marks areas to be erased.
        """
        mask = np.zeros(image_shape, dtype=np.uint8)
        
        if segmentation_data:
            # Use intelligent segmentation masks (already optimized per-region)
            for seg_result in segmentation_data.values():
                mask = cv2.bitwise_or(mask, seg_result.mask)
            
            # Validate: mask should not exceed 50% of image (safety check)
            mask_coverage = np.count_nonzero(mask) / (image_shape[0] * image_shape[1])
            if mask_coverage > 0.5:
                logger.warning(
                    f"Mask coverage {mask_coverage:.1%} exceeds 50%; "
                    "falling back to simple bbox dilation."
                )
                mask = np.zeros(image_shape, dtype=np.uint8)
                for x_min, y_min, x_max, y_max in bboxes:
                    mask[y_min:y_max, x_min:x_max] = 255
                if self.dilation_kernel > 0:
                    dynamic_kernel_size = max(
                        self.dilation_kernel, int(image_shape[1] * 0.015)
                    )
                    kernel = np.ones(
                        (dynamic_kernel_size, dynamic_kernel_size), dtype=np.uint8
                    )
                    mask = cv2.dilate(mask, kernel, iterations=1)
        else:
            # Fallback: simple bbox dilation (original behavior)
            for x_min, y_min, x_max, y_max in bboxes:
                mask[y_min:y_max, x_min:x_max] = 255

            if self.dilation_kernel > 0:
                dynamic_kernel_size = max(
                    self.dilation_kernel, int(image_shape[1] * 0.015)
                )
                kernel = np.ones(
                    (dynamic_kernel_size, dynamic_kernel_size), dtype=np.uint8
                )
                mask = cv2.dilate(mask, kernel, iterations=1)

        return mask

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def erase(
        self,
        image: np.ndarray,
        bboxes: list[list[int]],
        textbox_list: list | None = None,
    ) -> np.ndarray:
        """Erase text regions from *image*.

        Supports two modes:
        1. Simple: bboxes only → simple bbox dilation.
        2. Intelligent: bboxes + textbox_list → bubble segmentation with
           Flood Fill for bubbles and conservative dilation for floating text.

        Args:
            image:  RGB image as ``np.ndarray`` of shape ``(H, W, 3)``.
            bboxes: List of axis-aligned bounding boxes to erase.
            textbox_list: Optional list of TextBox objects for intelligent segmentation.

        Returns:
            Inpainted image as ``np.ndarray`` of shape ``(H, W, 3)`` in RGB.
        """
        if not bboxes:
            logger.debug("No bounding boxes provided; returning original image.")
            return image.copy()

        h, w = image.shape[:2]
        
        # Decide whether to use intelligent segmentation
        segmentation_data = None
        if textbox_list is not None:
            try:
                segmentation_data = classify_text_region(
                    image,
                    textbox_list,
                    variance_threshold=0.15,
                )
                logger.debug(
                    f"Intelligent segmentation applied: {len(segmentation_data)} regions."
                )
            except Exception as e:
                logger.warning(
                    f"Intelligent segmentation failed ({e}); "
                    "falling back to simple bbox dilation."
                )
        
        mask = self._build_mask((h, w), bboxes, segmentation_data=segmentation_data)

        if self._effective_method == "lama":
            return self._inpaint_lama(image, mask)
        return self._inpaint_opencv(image, mask)

    def erase_with_mask(
        self,
        image: np.ndarray,
        mask: np.ndarray,
    ) -> np.ndarray:
        """Erase text regions from *image* using a pre-built mask.

        Args:
            image: RGB image as ``np.ndarray`` of shape ``(H, W, 3)``.
            mask:  ``uint8`` mask of shape ``(H, W)``; ``255`` = erase area.

        Returns:
            Inpainted image as ``np.ndarray`` of shape ``(H, W, 3)`` in RGB.
        """
        if self._effective_method == "lama":
            return self._inpaint_lama(image, mask)
        return self._inpaint_opencv(image, mask)

    # ------------------------------------------------------------------
    # Strategy implementations
    # ------------------------------------------------------------------

    def _inpaint_opencv(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """Classical OpenCV inpainting (Telea or Navier-Stokes).

        Args:
            image: RGB image.
            mask:  Binary mask (``255`` = inpaint here).

        Returns:
            Inpainted RGB image.
        """
        bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        
        # Hack for mangas: OpenCV inpainting smears high-contrast edges (black text
        # on white background) if the mask is near the text. Because we strictly use
        # rectangular bounding-box masks, we first overwrite the masked area with pure
        # white. This destroys the black text immediately, forcing cv2.inpaint to only
        # pull colors from OUTSIDE the bounding box (i.e. the bubble background color).
        bgr[mask == 255] = (255, 255, 255)

        flag = cv2.INPAINT_TELEA if self.opencv_method == "telea" else cv2.INPAINT_NS
        result_bgr = cv2.inpaint(bgr, mask, inpaintRadius=5, flags=flag)
        return cv2.cvtColor(result_bgr, cv2.COLOR_BGR2RGB)

    def _inpaint_lama(self, image: np.ndarray, mask: np.ndarray) -> np.ndarray:
        """Deep-learning inpainting using LaMa (simple-lama-inpainting).

        Args:
            image: RGB image as ``np.ndarray`` of shape ``(H, W, 3)``.
            mask:  Binary mask (``255`` = inpaint here), shape ``(H, W)``.

        Returns:
            Inpainted RGB image as ``np.ndarray`` of shape ``(H, W, 3)``.
        """
        from PIL import Image  # late import — Pillow is always present

        pil_image = Image.fromarray(image)  # RGB numpy → PIL RGB
        pil_mask = Image.fromarray(mask)    # uint8 numpy → PIL L

        result_pil = self._model(pil_image, pil_mask)

        # SimpleLama returns a PIL Image in RGB mode.
        return np.array(result_pil)
