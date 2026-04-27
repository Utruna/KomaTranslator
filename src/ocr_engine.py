"""
ocr_engine.py
-------------
Text detection and recognition using a hybrid approach.
Detects text bounding boxes using Ultralytics YOLOv8 (comic-text-detector)
and then crops those boxes to read the text with PaddleOCR (for optimal CJK reading).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
import os

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
    """OCR Engine via Koharu Headless API.
    Sends the image to a local Koharu instance running in headless mode,
    triggering detection and OCR steps to retrieve high-quality text bounding boxes.
    """

    def __init__(
        self,
        backend_url: str = "http://127.0.0.1:4000/api/v1",
        **extra_kwargs: Any,
    ) -> None:
        self.backend_url = backend_url.rstrip("/")
        self._extra_kwargs = extra_kwargs

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, image: np.ndarray) -> list[TextBox]:
        """Hybrid run: Detect via Koharu API."""
        import cv2
        import time
        import requests
        import json
        
        boxes: list[TextBox] = []
        logger.info(f"Connecting to Koharu headless API at {self.backend_url}...")

        # 1. Create a transient project session in Koharu
        try:
            proj_resp = requests.post(f"{self.backend_url}/projects", json={"name": f"koma-ocr-{int(time.time())}"}, timeout=5)
            proj_resp.raise_for_status()
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to connect to Koharu API: {e} \n Ensure it's running via: koharu.exe --port 4000 --headless")
            return boxes

        try:
            # 2. Upload image to the current Koharu page state
            logger.info("Uploading image to Koharu...")
            pil_image = image
            # Encode image in memory (OpenCV format BGR is needed for cv2.imencode)
            if image.shape[2] == 3:
                bgr_image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
            else:
                bgr_image = image
                
            success, img_encoded = cv2.imencode(".png", bgr_image)
            if not success:
                logger.error("Failed to encode image to PNG.")
                return boxes
                
            files = {"file": ("page.png", img_encoded.tobytes(), "image/png")}
            # The docs specify: POST /api/v1/pages -> multipart upload
            page_resp = requests.post(f"{self.backend_url}/pages", files=files, timeout=30)
            page_resp.raise_for_status()

            # 3. Retrieve default configured engine models (detector, OCR)
            # Default to comic-text-detector and manga-ocr as they are specifically for comic books,
            # pp-doclayout-v3 often fails on bubbles.
            detector_id = "comic-text-detector"
            ocr_id = "manga-ocr"

            # 4. Trigger Koharu pipeline with ONLY detector and OCR (to avoid unnecessary translation/rendering overhead)
            logger.info(f"Triggering Koharu pipeline steps: [{detector_id}, {ocr_id}]")
            pipe_resp = requests.post(f"{self.backend_url}/pipelines", json={
                "steps": [detector_id, ocr_id]
            }, timeout=10)
            pipe_resp.raise_for_status()
            op_id = pipe_resp.json().get("operationId")

            # 5. Wait for pipeline completion
            logger.info("Waiting for Koharu pipeline to complete...")
            time.sleep(1) # brief pause to let it start
            max_retries = 30
            for _ in range(max_retries):
                try:
                    # In Koharu, operations are kept in /operations 
                    ops_resp = requests.get(f"{self.backend_url}/operations", timeout=5).json()
                    is_active = False
                    
                    if isinstance(ops_resp, list):
                        for op in ops_resp:
                            if op.get("id") == op_id and op.get("status") not in ["finished", "failed"]:
                                is_active = True
                    elif isinstance(ops_resp, dict):
                        # It might be mapping of id -> {status: ...}
                        op = ops_resp.get(op_id)
                        if op and op.get("status") not in ["finished", "failed"]:
                            is_active = True
                            
                    if not is_active:
                        break
                except Exception as e:
                    logger.debug(f"Operation poll failed, retrying... {e}")
                time.sleep(1)

            # 6. Fetch parsed Scene from Koharu
            logger.info("Fetching scene.json from Koharu...")
            scene_resp = requests.get(f"{self.backend_url}/scene.json", timeout=10)
            scene_resp.raise_for_status()
            scene_data = scene_resp.json()

            # 7. Extract TextBoxes 
            scene_nodes = scene_data.get("scene", {}).get("pages", {})
            # If structure differs
            if not scene_nodes:
                scene_nodes = scene_data.get("pages", {})
                
            all_nodes = {}
            for page_id, page in scene_nodes.items():
                all_nodes.update(page.get("nodes", {}))
                
            for node_id, node in all_nodes.items():
                node_kind = node.get("kind", {})
                node_type = node.get("type", "").lower()
                text_info = node.get("text", {})
                
                # Check if it's nested under "kind": {"text": {...}}
                if "text" in node_kind:
                    text_info = node_kind["text"]
                elif node_type == "text":
                    # Fallback for alternative structures
                    pass
                
                text = text_info.get("text", "") if isinstance(text_info, dict) else text_info
                
                if "text" in node_kind or node_type == "text" or text:
                    # Search for bound formats (Koharu usually uses rect, bounds, bbox, geometry, or transform on the node itself)
                    rect = node.get("transform") or node.get("rect") or node.get("bounds") or node.get("geometry")
                    if not rect:
                        continue
                        
                    # Standardize rect parsing to [x, y, w, h] or similar nested dict
                    x1, y1, x2, y2 = 0, 0, 0, 0
                    if isinstance(rect, dict):
                        x1 = rect.get("x", 0)
                        y1 = rect.get("y", 0)
                        x2 = x1 + rect.get("width", rect.get("w", 0))
                        y2 = y1 + rect.get("height", rect.get("h", 0))
                    elif isinstance(rect, list) and len(rect) == 4:
                        # Assuming [x, y, w, h] or [x1, y1, x2, y2]
                        if rect[2] > 10000 or rect[3] > 10000: # heuristic
                            pass # Probably points
                        else:
                            # Assume [x, y, w, h]
                            x1, y1 = rect[0], rect[1]
                            x2, y2 = x1 + rect[2], y1 + rect[3]
                            
                    # Build polygon
                    poly = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
                    
                    confidence = 1.0
                    if isinstance(text_info, dict):
                        confidence = text_info.get("confidence", 1.0)
                    else:
                        confidence = node.get("confidence", 1.0)
                    
                    if text.strip() and x2 > x1 and y2 > y1:
                        boxes.append(TextBox(polygon=poly, text=text.strip(), confidence=confidence))
            
            if not boxes:
                # Debug dump if no boxes found to help reverse-engineer internal Koharu format
                debug_path = "koharu_scene_debug.json"
                with open(debug_path, "w", encoding="utf-8") as f:
                    json.dump(scene_data, f, indent=2, ensure_ascii=False)
                logger.warning(f"No text boxes retrieved! Saved Scene JSON to {debug_path} for inspection.")
            
        except Exception as e:
            logger.error(f"Error during Koharu detection: {e}")
            import traceback
            logger.error(traceback.format_exc())
            
        finally:
            # 8. Clean up active Koharu project
            try:
                requests.delete(f"{self.backend_url}/projects/current", timeout=3)
            except:
                pass
                
        logger.info(f"Koharu API returned {len(boxes)} text regions.")
        return boxes
