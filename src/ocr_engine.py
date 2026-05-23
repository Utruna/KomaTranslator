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
import cv2
import numpy as np

from src.utils import get_logger

logger = get_logger(__name__)
logger.setLevel(10)


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
        engine: str = "paddle-ocr",
        **extra_kwargs: Any,
    ) -> None:
        self.backend_url = backend_url.rstrip("/")
        self.engine = engine
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

        def _extract_operation_id(payload: Any) -> str | None:
            if isinstance(payload, dict):
                for key in ("operationId", "operation_id", "id"):
                    value = payload.get(key)
                    if value:
                        return str(value)
                for key in ("data", "result", "operation"):
                    nested_value = _extract_operation_id(payload.get(key))
                    if nested_value:
                        return nested_value
            if isinstance(payload, list):
                for item in payload:
                    nested_value = _extract_operation_id(item)
                    if nested_value:
                        return nested_value
            return None

        def _candidate_engines() -> list[str]:
            ordered = [self.engine, "paddle-ocr", "ppocr", "ch-ocr", "paddle-ocr-vl-1.5"]
            candidates: list[str] = []
            for name in ordered:
                if name and name not in candidates:
                    candidates.append(name)
            return candidates
        
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
            detector_id = "comic-text-detector"
            ocr_candidates = _candidate_engines()

            # 4. Trigger Koharu pipeline with detector and a Chinese OCR engine
            op_id = None
            chosen_ocr_id = None
            last_error = None
            for ocr_id in ocr_candidates:
                logger.info(f"Triggering Koharu pipeline steps: [{detector_id}, {ocr_id}]")
                try:
                    pipe_resp = requests.post(
                        f"{self.backend_url}/pipelines",
                        json={"steps": [detector_id, ocr_id]},
                        timeout=10,
                    )
                    logger.debug("Koharu POST /pipelines HTTP %s for OCR engine '%s'", pipe_resp.status_code, ocr_id)
                    pipe_resp.raise_for_status()
                    pipe_data = pipe_resp.json()
                    logger.debug("Koharu POST /pipelines response: %s", pipe_data)
                    op_id = _extract_operation_id(pipe_data)
                    if op_id:
                        chosen_ocr_id = ocr_id
                        break
                    last_error = f"No operation id returned for OCR engine '{ocr_id}'."
                except Exception as e:
                    last_error = f"OCR engine '{ocr_id}' failed: {e}"
                    logger.debug(last_error)
                    continue

            if op_id is None:
                logger.error(
                    "Aucun engine OCR chinois n'a fonctionné. Engines essayés: %s",
                    ", ".join(ocr_candidates),
                )
                if last_error:
                    logger.error("Dernière erreur: %s", last_error)
                return boxes

            logger.info("Using Koharu OCR engine '%s' with operation %s.", chosen_ocr_id, op_id)

            # 5. Wait for pipeline completion
            logger.info("Waiting for Koharu pipeline to complete...")
            time.sleep(1) # brief pause to let it start
            max_retries = 60
            for _ in range(max_retries):
                try:
                    ops_resp = requests.get(f"{self.backend_url}/operations", timeout=5).json()
                    logger.debug("Koharu GET /operations response: %s", ops_resp)
                    operations = []
                    if isinstance(ops_resp, dict):
                        operations = ops_resp.get("operations", [])
                    elif isinstance(ops_resp, list):
                        operations = ops_resp

                    matched_operation = None
                    if op_id is not None:
                        for op in operations:
                            if op.get("id") == op_id:
                                matched_operation = op
                                break

                    if matched_operation is not None:
                        status = str(matched_operation.get("status", "")).lower()
                        if status == "completed":
                            break
                        if status == "failed":
                            logger.error("Koharu operation %s failed: %s", op_id, matched_operation)
                            return boxes
                    elif op_id is None:
                        # Pas d'id exploitable, on laisse Koharu terminer son travail pendant la fenêtre complète.
                        pass
                    else:
                        break
                except Exception as e:
                    logger.debug(f"Operation poll failed, retrying... {e}")
                time.sleep(2)

            # Laisser Koharu écrire le scene.json avant de l'interroger.
            time.sleep(2)

            # 6. Fetch parsed Scene from Koharu
            logger.info("Fetching scene.json from Koharu...")
            scene_resp = requests.get(f"{self.backend_url}/scene.json", timeout=10)
            scene_resp.raise_for_status()
            scene_data = scene_resp.json()

            # 7. Extract TextBoxes (Corrected for deep nesting found in koharu_scene_debug.json)
            pages = scene_data.get("scene", {}).get("pages", {})
            if not pages:
                pages = scene_data.get("pages", {})

            for page_id, page in pages.items():
                nodes = page.get("nodes", {})
                if logger.isEnabledFor(10):
                    preview_nodes = []
                    for node_id, node in list(nodes.items())[:3]:
                        preview_nodes.append({
                            "page_id": page_id,
                            "node_id": node_id,
                            "kind": node.get("kind"),
                        })
                    logger.debug("Koharu scene node preview (first 3): %s", preview_nodes)
                for node_id, node in nodes.items():
                    # Koharu marks text regions specifically with type 'text_region' or kind 'text'
                    node_type = str(node.get("type", "")).lower()
                    node_kind = node.get("kind", {})
                    data = node.get("data", {})
                    
                    text = ""
                    confidence = 1.0
                    
                    # Logic to extract text and confidence based on node structure
                    if node_type == "text_region" or "text" in node_kind:
                        text_info = data if data else node_kind.get("text", {})
                        if isinstance(text_info, dict):
                            text = text_info.get("text", "")
                            confidence = text_info.get("confidence", 1.0)
                        else:
                            text = str(text_info)

                        if text is None:
                            logger.warning(
                                "Koharu returned a text node with null text (page=%s node=%s confidence=%s); keeping bbox.",
                                page_id,
                                node_id,
                                confidence,
                            )
                            text = ""
                    
                    if not text:
                        continue

                    # Search for coordinates in 'transform' or 'rect' (優先 transform)
                    rect = node.get("transform") or node.get("rect") or node.get("bounds")
                    if not rect:
                        continue

                    x1, y1, x2, y2 = 0.0, 0.0, 0.0, 0.0
                    if isinstance(rect, dict):
                        x1 = float(rect.get("x", 0))
                        y1 = float(rect.get("y", 0))
                        x2 = x1 + float(rect.get("width", rect.get("w", 0)))
                        y2 = y1 + float(rect.get("height", rect.get("h", 0)))
                    elif isinstance(rect, list) and len(rect) == 4:
                        try:
                            a, b, c, d = float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3])
                            # Heuristic: simple [x, y, w, h]
                            x1, y1 = a, b
                            x2, y2 = x1 + c, y1 + d
                        except Exception:
                            continue

                    # Build polygon
                    poly = [
                        [float(x1), float(y1)], 
                        [float(x2), float(y1)], 
                        [float(x2), float(y2)], 
                        [float(x1), float(y2)]
                    ]
                    
                    if text.strip() and x2 > x1 and y2 > y1:
                        boxes.append(TextBox(polygon=poly, text=text.strip(), confidence=confidence))
            
            if not boxes:
                # Count text-kind nodes to distinguish "no text detected" from "OCR recognition failed"
                text_nodes_count = sum(
                    1
                    for page in scene_data.get("scene", {}).get("pages", {}).values()
                    for node in page.get("nodes", {}).values()
                    if "text" in node.get("kind", {})
                )
                if text_nodes_count > 0:
                    logger.warning(
                        "Koharu detected %d text region(s) but OCR recognition returned no text "
                        "(all 'text' fields are null). The OCR engine may have failed silently. "
                        "Try a different engine in config.yaml (ocr.engine).",
                        text_nodes_count,
                    )
                debug_path = "koharu_scene_debug.json"
                with open(debug_path, "w", encoding="utf-8") as f:
                    json.dump(scene_data, f, indent=2, ensure_ascii=False)
                logger.warning("Saved scene JSON to %s for inspection.", debug_path)
            
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
