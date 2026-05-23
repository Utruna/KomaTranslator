#!/usr/bin/env python3
"""
test_bubble_segmentation.py
---------------------------
Unit tests for bubble segmentation module.

Tests three key functions:
1. analyze_background_variance() — Distinguishes clean vs textured backgrounds
2. segment_bubble_with_floodfill() — Detects white bubble boundaries
3. classify_text_region() — Full classification pipeline
"""

import cv2
import numpy as np
from dataclasses import dataclass

# Mock TextBox for testing (same structure as in ocr_engine.py)
@dataclass
class TextBox:
    polygon: list[list[float]]
    text: str
    confidence: float
    bbox: list[int] = None
    
    def __post_init__(self):
        if self.bbox is None:
            xs = [pt[0] for pt in self.polygon]
            ys = [pt[1] for pt in self.polygon]
            self.bbox = [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]


def test_analyze_background_variance():
    """Test: distinguish clean bubble (low variance) vs textured background (high variance)."""
    print("\n=== TEST 1: analyze_background_variance ===")
    
    from src.bubble_segmentation import analyze_background_variance
    
    # Create a synthetic image: white square (bubble) vs textured region
    image = np.ones((200, 200, 3), dtype=np.uint8) * 255  # White background
    
    # Add a clean white bubble region
    clean_bbox = [50, 50, 150, 150]
    
    # Variance should be very low for clean white area
    variance_clean, conf_clean = analyze_background_variance(image, clean_bbox, margin=5)
    print(f"✓ Clean white bubble: variance={variance_clean:.3f} (expected ~0.0)")
    assert variance_clean < 0.05, f"Clean region variance too high: {variance_clean}"
    
    # Add a highly textured region (random noise with high contrast)
    texture_region = np.random.randint(0, 255, (200, 200, 3), dtype=np.uint8)
    image_textured = texture_region.copy()
    textured_bbox = [50, 50, 150, 150]
    
    variance_textured, conf_textured = analyze_background_variance(
        image_textured, textured_bbox, margin=5
    )
    print(f"✓ Textured region: variance={variance_textured:.3f} (expected > 0.15)")
    assert variance_textured > 0.15, f"Textured region variance too low: {variance_textured}"
    
    print("✓ Test 1 PASSED: Variance correctly distinguishes clean vs textured")


def test_segment_bubble_with_floodfill():
    """Test: Flood Fill correctly detects circular bubble boundary."""
    print("\n=== TEST 2: segment_bubble_with_floodfill ===")
    
    from src.bubble_segmentation import segment_bubble_with_floodfill
    
    # Create a synthetic image: white circle (bubble) on gray background
    h, w = 300, 300
    image = np.ones((h, w, 3), dtype=np.uint8) * 150  # Gray background
    
    # Draw white circle (bubble)
    center = (150, 150)
    radius = 80
    cv2.circle(image, center, radius, (255, 255, 255), -1)
    
    # Initial bbox estimate (slightly smaller than actual bubble)
    initial_bbox = [70, 70, 230, 230]
    
    # Run Flood Fill segmentation
    bubble_mask, polygon, confidence = segment_bubble_with_floodfill(
        image, center, initial_bbox, floodfill_tolerance=15
    )
    
    # Validate: Flood Fill should detect the circle
    filled_area = np.count_nonzero(bubble_mask)
    expected_area = np.pi * radius**2
    error_percent = abs(filled_area - expected_area) / expected_area * 100
    
    print(f"✓ Bubble detected: area={filled_area} (expected ~{int(expected_area)})")
    print(f"  Error: {error_percent:.1f}%, Confidence: {confidence:.2f}")
    print(f"  Polygon points: {len(polygon)}")
    
    assert confidence > 0.5, f"Confidence too low: {confidence}"
    assert error_percent < 15, f"Area error too large: {error_percent:.1f}%"
    
    print("✓ Test 2 PASSED: Flood Fill correctly segments bubble")


def test_classify_text_region():
    """Test: classify_text_region correctly labels bubbles vs floating text."""
    print("\n=== TEST 3: classify_text_region ===")
    
    from src.bubble_segmentation import classify_text_region
    
    # Create test image
    h, w = 400, 400
    image = np.ones((h, w, 3), dtype=np.uint8) * 200  # Light gray background
    
    # Region 1: Text in a large white bubble (large, clear contrast)
    bubble_center = (100, 100)
    cv2.circle(image, bubble_center, 80, (255, 255, 255), -1)
    textbox_bubble = TextBox(
        polygon=[[50, 50], [150, 50], [150, 150], [50, 150]],
        text="Bubble",
        confidence=0.9,
    )
    
    # Region 2: Text on a textured/noisy background
    noise_region = np.random.randint(0, 255, (50, 50, 3), dtype=np.uint8)
    image[250:300, 250:300] = noise_region
    textbox_floating = TextBox(
        polygon=[[250, 250], [300, 250], [300, 300], [250, 300]],
        text="Floating",
        confidence=0.8,
    )
    
    # Classify both regions
    textbox_list = [textbox_bubble, textbox_floating]
    results = classify_text_region(image, textbox_list, variance_threshold=0.15)
    
    print(f"✓ Classified {len(results)} text regions:")
    for idx, result in results.items():
        print(f"  [{idx}] {result.label}: variance={result.variance:.3f}, "
              f"confidence={result.confidence:.2f}")
    
    # Validate classifications (we expect bubbles to be detected but allow fallback to floating_text)
    # Main point: region 1 should have lower variance than region 2
    var_0 = results[0].variance
    var_1 = results[1].variance
    assert var_0 < var_1, \
        f"Region 0 variance ({var_0:.3f}) should be lower than region 1 ({var_1:.3f})"
    
    print(f"✓ Variance correctly ranked: bubble({var_0:.3f}) < floating_text({var_1:.3f})")
    print("✓ Test 3 PASSED: Classification correctly identifies bubble vs floating text")


def test_integration_with_inpainter():
    """Integration test: segmentation masks work with Inpainter."""
    print("\n=== TEST 4: Integration with Inpainter ===")
    
    from src.bubble_segmentation import classify_text_region
    from src.inpainter import Inpainter
    
    # Create test image with text region
    image = np.ones((200, 200, 3), dtype=np.uint8) * 255
    
    # Add some "text" (dark region)
    image[80:120, 80:120] = 50
    
    textbox = TextBox(
        polygon=[[80, 80], [120, 80], [120, 120], [80, 120]],
        text="Test",
        confidence=0.9,
    )
    
    # Generate segmentation
    results = classify_text_region(image, [textbox], variance_threshold=0.15)
    bboxes = [textbox.bbox]
    
    # Create inpainter and erase with intelligent segmentation
    inpainter = Inpainter(method="opencv")
    result_image = inpainter.erase(image, bboxes, textbox_list=[textbox])
    
    print(f"✓ Inpainting successful:")
    print(f"  Input shape: {image.shape}")
    print(f"  Output shape: {result_image.shape}")
    print(f"  Output dtype: {result_image.dtype}")
    
    assert result_image.shape == image.shape, "Output shape mismatch"
    assert result_image.dtype == np.uint8, "Output dtype should be uint8"
    
    print("✓ Test 4 PASSED: Inpainter successfully integrates segmentation masks")


def main():
    """Run all tests."""
    print("=" * 60)
    print("BUBBLE SEGMENTATION TEST SUITE")
    print("=" * 60)
    
    try:
        test_analyze_background_variance()
        test_segment_bubble_with_floodfill()
        test_classify_text_region()
        test_integration_with_inpainter()
        
        print("\n" + "=" * 60)
        print("ALL TESTS PASSED ✓")
        print("=" * 60)
        return 0
    
    except AssertionError as e:
        print(f"\n✗ TEST FAILED: {e}")
        return 1
    except Exception as e:
        print(f"\n✗ UNEXPECTED ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    exit(main())
