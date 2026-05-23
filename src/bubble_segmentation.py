"""
bubble_segmentation.py
---------------------
Advanced bubble and floating text segmentation for optimal inpainting masks.

This module provides intelligent segmentation of text regions in manga panels:

1. **Bubble Detection**: Uses Flood Fill from the text center to identify white
   speech bubbles, then detects contours to extract precise boundaries.
   
2. **Floating Text Detection**: Analyzes background variance to distinguish
   texturized backgrounds (floating text) from clean speech bubbles.
   
3. **Mask Generation**: Creates optimized inpainting masks:
   - Bubbles: Precise Flood Fill + contour-based mask
   - Floating text: Simple morphological dilation (avoids over-extension)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np

from src.utils import get_logger

logger = get_logger(__name__)


@dataclass
class SegmentationResult:
    """Result of bubble/floating text classification for a single text region."""
    
    label: Literal["bubble", "floating_text"]
    """'bubble' for white speech bubbles, 'floating_text' for complex backgrounds."""
    
    mask: np.ndarray
    """Binary mask (uint8, 0/255) optimized for inpainting; shape (H, W)."""
    
    polygon: list[list[int]]
    """Extended polygon coordinates [[x, y], ...] for typesetting (used downstream)."""
    
    confidence: float
    """Confidence score [0, 1] indicating classification certainty."""
    
    variance: float
    """Background variance score used for classification."""


def analyze_background_variance(
    image: np.ndarray,
    bbox: list[int],
    margin: int = 5,
) -> tuple[float, float]:
    """Analyze background variance around a text bounding box.
    
    Extracts a region around the bbox and computes the standard deviation
    of grayscale values to distinguish clean bubbles (low variance) from
    complex/textured backgrounds (high variance).
    
    Args:
        image: RGB image as np.ndarray of shape (H, W, 3).
        bbox: Text bounding box [x_min, y_min, x_max, y_max].
        margin: Pixels to extend around bbox for analysis (default 5).
    
    Returns:
        Tuple of (variance_score, confidence):
        - variance_score: Normalized [0, 1] estimate of background complexity.
        - confidence: [0, 1] how confident the classification is (based on sample size).
    """
    h, w = image.shape[:2]
    x_min, y_min, x_max, y_max = bbox
    
    # Expand region by margin, clipped to image bounds
    x_min_exp = max(0, x_min - margin)
    y_min_exp = max(0, y_min - margin)
    x_max_exp = min(w, x_max + margin)
    y_max_exp = min(h, y_max + margin)
    
    region = image[y_min_exp:y_max_exp, x_min_exp:x_max_exp]
    
    if region.size == 0:
        logger.warning(f"Empty region for bbox {bbox}; returning default variance.")
        return 0.0, 0.0
    
    # Convert to grayscale and compute statistics
    gray = cv2.cvtColor(region, cv2.COLOR_RGB2GRAY) if len(region.shape) == 3 else region
    variance = float(np.std(gray)) / 255.0  # Normalize to [0, 1]
    
    # Confidence: larger regions have higher confidence
    region_area = (x_max_exp - x_min_exp) * (y_max_exp - y_min_exp)
    bbox_area = (x_max - x_min) * (y_max - y_min)
    confidence = min(1.0, region_area / max(bbox_area, 1))
    
    return variance, confidence


def segment_bubble_with_floodfill(
    image: np.ndarray,
    text_center: tuple[int, int],
    initial_bbox: list[int],
    floodfill_tolerance: int = 15,
    max_bubble_expansion: float = 8.0,
) -> tuple[np.ndarray, list[list[int]], float]:
    """Segment a white speech bubble using Flood Fill from the text center.
    
    This function attempts to identify the true boundary of a white speech bubble
    by launching a Flood Fill algorithm from the center of the text. If successful,
    it traces the bubble contours and returns a precise mask.
    
    Args:
        image: RGB image as np.ndarray of shape (H, W, 3).
        text_center: (x, y) center point of the text region.
        initial_bbox: Initial text bbox [x_min, y_min, x_max, y_max].
        floodfill_tolerance: Color distance tolerance for Flood Fill (default 15,
                            tolerates light gray in scanned pages).
        max_bubble_expansion: Maximum allowed bubble area relative to text area
                             (default 8.0x) to prevent runaway contours.
    
    Returns:
        Tuple of (mask, polygon, confidence):
        - mask: Binary uint8 mask of shape (H, W) where 255 = bubble region.
        - polygon: Approximate polygon of bubble boundary [[x, y], ...].
        - confidence: [0, 1] confidence in the detection.
    """
    h, w = image.shape[:2]
    cx, cy = int(text_center[0]), int(text_center[1])
    
    # Validate center is in bounds
    if not (0 <= cx < w and 0 <= cy < h):
        logger.warning(f"Text center {text_center} out of bounds ({h}x{w}).")
        return np.zeros((h, w), dtype=np.uint8), [], 0.0
    
    try:
        # Convert to grayscale for Flood Fill
        gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
        
        # Create a mask for Flood Fill (must be 1 pixel larger on all sides)
        seed_mask = np.zeros((h + 2, w + 2), dtype=np.uint8)
        
        # Perform Flood Fill from the text center
        cv2.floodFill(
            gray,
            seed_mask,
            (cx, cy),
            newVal=0,  # Mark filled area as 0 (not used; we extract from seed_mask)
            loDiff=floodfill_tolerance,
            upDiff=floodfill_tolerance,
            flags=cv2.FLOODFILL_MASK_ONLY,
        )
        
        # Extract the actual filled region (remove border)
        floodfill_mask = seed_mask[1:-1, 1:-1]
        
        # Find contours in the Flood Fill result
        contours, _ = cv2.findContours(
            floodfill_mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE
        )
        
        if not contours:
            logger.debug("No contours found from Flood Fill; bubble detection failed.")
            return np.zeros((h, w), dtype=np.uint8), [], 0.0
        
        # Select the largest contour (likely the bubble boundary)
        largest_contour = max(contours, key=cv2.contourArea)
        
        # Get bounding rect to validate size
        x, y, cw, ch = cv2.boundingRect(largest_contour)
        text_area = (initial_bbox[2] - initial_bbox[0]) * (initial_bbox[3] - initial_bbox[1])
        bubble_area = cw * ch
        
        # Sanity check: bubble should not be unreasonably large
        if bubble_area > text_area * max_bubble_expansion:
            logger.debug(
                f"Bubble area {bubble_area} > {text_area * max_bubble_expansion} "
                "(max allowed); detection unreliable."
            )
            return np.zeros((h, w), dtype=np.uint8), [], 0.0
        
        # Create final mask from the largest contour
        bubble_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.drawContours(bubble_mask, [largest_contour], 0, 255, -1)
        
        # Approximate polygon for downstream typesetting
        epsilon = 0.02 * cv2.arcLength(largest_contour, True)
        polygon_approx = cv2.approxPolyDP(largest_contour, epsilon, True)
        polygon = [[int(pt[0][0]), int(pt[0][1])] for pt in polygon_approx]
        
        # Confidence: larger detected bubble = higher confidence
        confidence = min(1.0, bubble_area / max(text_area, 1))
        
        logger.debug(
            f"Bubble detected: area={bubble_area}, ratio={bubble_area/text_area:.2f}x, "
            f"confidence={confidence:.2f}"
        )
        
        return bubble_mask, polygon, confidence
    
    except Exception as e:
        logger.warning(f"Flood Fill segmentation failed: {e}")
        return np.zeros((h, w), dtype=np.uint8), [], 0.0

def is_complex_texture(roi):
    # On utilise skimage.feature pour extraire des caractéristiques de texture
    from skimage.feature import graycomatrix, graycoprops
    
    gray = cv2.cvtColor(roi, cv2.COLOR_RGB2GRAY)
    # Calcul de la matrice de co-occurrence
    glcm = graycomatrix(gray, distances=[1], angles=[0], levels=256, symmetric=True, normed=True)
    
    # Extraction de l'homogénéité et de l'énergie
    homogeneity = graycoprops(glcm, 'homogeneity')[0, 0]
    energy = graycoprops(glcm, 'energy')[0, 0]
    
    # Une bulle est très homogène (> 0.8) et a une énergie stable
    # Un décor (trame) fera chuter l'homogénéité
    return homogeneity < 0.6

def classify_text_region(
    image: np.ndarray,
    textbox_list: list,
    variance_threshold: float = 0.15,
    floating_text_dilation_kernel: tuple[int, int] = (3, 3),
    floating_text_dilation_iterations: int = 2,
) -> dict[int, SegmentationResult]:
    """Classify each text region as bubble or floating text, and generate masks.
    
    This is the main entry point for bubble segmentation. For each TextBox:
    1. Analyzes background variance (clean = bubble, textured = floating text)
    2. For bubbles: attempts precise Flood Fill + contour detection
    3. For floating text: applies conservative morphological dilation
    
    Args:
        image: RGB image as np.ndarray of shape (H, W, 3).
        textbox_list: List of TextBox objects (with .polygon, .bbox attributes).
        variance_threshold: Threshold to classify as floating text (default 0.15).
        floating_text_dilation_kernel: Kernel size for morphological dilation of
                                       floating text (default (3, 3)).
        floating_text_dilation_iterations: Number of dilation iterations
                                          (default 2, conservative).
    
    Returns:
        Dictionary mapping textbox index → SegmentationResult:
        {
            0: SegmentationResult(label='bubble', mask=..., polygon=...),
            1: SegmentationResult(label='floating_text', mask=..., polygon=...),
            ...
        }
    """
    h, w = image.shape[:2]
    results: dict[int, SegmentationResult] = {}
    
    for idx, textbox in enumerate(textbox_list):
        bbox = textbox.bbox
        x_min, y_min, x_max, y_max = bbox
        
        # Step 1: Analyze background variance
        variance, var_confidence = analyze_background_variance(image, bbox, margin=5)
        
        # Step 2: Classify as bubble or floating text
        if variance > variance_threshold:
            # High variance → floating text on complex background
            logger.debug(f"TextBox {idx}: variance={variance:.3f} > {variance_threshold} → floating_text")
            
            # Create conservative dilation mask
            mask = np.zeros((h, w), dtype=np.uint8)
            mask[y_min:y_max, x_min:x_max] = 255
            
            # Apply light dilation
            kernel = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, floating_text_dilation_kernel
            )
            mask = cv2.dilate(mask, kernel, iterations=floating_text_dilation_iterations)
            
            # Polygon = simple rectangle (for typesetting, will expand slightly)
            x_dil = (x_max - x_min) * 0.1
            y_dil = (y_max - y_min) * 0.1
            polygon = [
                [int(x_min - x_dil), int(y_min - y_dil)],
                [int(x_max + x_dil), int(y_min - y_dil)],
                [int(x_max + x_dil), int(y_max + y_dil)],
                [int(x_min - x_dil), int(y_max + y_dil)],
            ]
            
            results[idx] = SegmentationResult(
                label="floating_text",
                mask=mask,
                polygon=polygon,
                confidence=var_confidence,
                variance=variance,
            )
        
        else:
            # Low variance → attempt bubble detection
            logger.debug(f"TextBox {idx}: variance={variance:.3f} ≤ {variance_threshold} → attempting bubble")
            
            # Text center for Flood Fill
            text_center = (
                (x_min + x_max) / 2.0,
                (y_min + y_max) / 2.0,
            )
            
            # Attempt Flood Fill segmentation
            bubble_mask, bubble_polygon, bubble_confidence = segment_bubble_with_floodfill(
                image,
                text_center,
                bbox,
                floodfill_tolerance=15,
                max_bubble_expansion=8.0,
            )
            
            if bubble_confidence > 0.5:
                # Successful bubble detection
                logger.debug(
                    f"TextBox {idx}: bubble detected with confidence={bubble_confidence:.2f}"
                )
                results[idx] = SegmentationResult(
                    label="bubble",
                    mask=bubble_mask,
                    polygon=bubble_polygon,
                    confidence=bubble_confidence,
                    variance=variance,
                )
            else:
                # Fallback to conservative dilation (treat as floating text)
                logger.debug(
                    f"TextBox {idx}: bubble detection failed (confidence={bubble_confidence:.2f}); "
                    "falling back to conservative dilation"
                )
                
                mask = np.zeros((h, w), dtype=np.uint8)
                mask[y_min:y_max, x_min:x_max] = 255
                
                kernel = cv2.getStructuringElement(
                    cv2.MORPH_ELLIPSE, floating_text_dilation_kernel
                )
                mask = cv2.dilate(mask, kernel, iterations=floating_text_dilation_iterations)
                
                # Polygon = simple rectangle
                x_dil = (x_max - x_min) * 0.1
                y_dil = (y_max - y_min) * 0.1
                polygon = [
                    [int(x_min - x_dil), int(y_min - y_dil)],
                    [int(x_max + x_dil), int(y_min - y_dil)],
                    [int(x_max + x_dil), int(y_max + y_dil)],
                    [int(x_min - x_dil), int(y_max + y_dil)],
                ]
                
                results[idx] = SegmentationResult(
                    label="floating_text",
                    mask=mask,
                    polygon=polygon,
                    confidence=bubble_confidence,
                    variance=variance,
                )
    
    logger.info(
        f"Segmentation complete: {len(results)} textboxes classified "
        f"({sum(1 for r in results.values() if r.label == 'bubble')} bubbles, "
        f"{sum(1 for r in results.values() if r.label == 'floating_text')} floating text)"
    )
    
    return results
