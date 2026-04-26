"""
utils.py
--------
Shared utilities for KomaTranslator:
  - configuration loading
  - image I/O helpers
  - centralised logger factory
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from PIL import Image


# ──────────────────────────────────────────────────────────────
# Logger
# ──────────────────────────────────────────────────────────────

def get_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """Return a named logger with a consistent console format.

    Args:
        name:  Logger name (usually ``__name__`` of the calling module).
        level: Logging level (default: ``logging.INFO``).

    Returns:
        Configured :class:`logging.Logger` instance.
    """
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        formatter = logging.Formatter(
            "[%(asctime)s] %(levelname)-8s %(name)s – %(message)s",
            datefmt="%H:%M:%S",
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    logger.setLevel(level)
    return logger


# ──────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────

def load_config(config_path: str | Path = "config.yaml") -> dict[str, Any]:
    """Load and return the YAML configuration file as a plain dict.

    Args:
        config_path: Path to the ``config.yaml`` file.

    Returns:
        Parsed configuration dictionary.

    Raises:
        FileNotFoundError: If *config_path* does not exist.
    """
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path.resolve()}")
    with config_path.open("r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


# ──────────────────────────────────────────────────────────────
# Image I/O
# ──────────────────────────────────────────────────────────────

def load_image(image_path: str | Path) -> np.ndarray:
    """Load an image from disk and return it as an RGB NumPy array.

    Args:
        image_path: Path to the source image (JPEG, PNG, WEBP, …).

    Returns:
        Image as ``np.ndarray`` of shape ``(H, W, 3)`` in RGB order.

    Raises:
        FileNotFoundError: If *image_path* does not exist.
    """
    image_path = Path(image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path.resolve()}")
    img = Image.open(image_path).convert("RGB")
    return np.array(img)


def save_image(image: np.ndarray, output_path: str | Path) -> None:
    """Save an RGB NumPy array to disk.

    Args:
        image:       Image as ``np.ndarray`` of shape ``(H, W, 3)`` in RGB order.
        output_path: Destination file path.  Parent directories are created
                     automatically if they do not exist.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    pil_img = Image.fromarray(image.astype(np.uint8))
    pil_img.save(output_path)


def list_images(directory: str | Path, extensions: tuple[str, ...] = (".jpg", ".jpeg", ".png", ".webp")) -> list[Path]:
    """Return all image files in *directory* sorted by name.

    Args:
        directory:  Folder to scan.
        extensions: File extensions to include (case-insensitive).

    Returns:
        Sorted list of :class:`pathlib.Path` objects.
    """
    directory = Path(directory)
    return sorted(
        p for p in directory.iterdir()
        if p.suffix.lower() in extensions
    )


def ensure_dir(path: str | Path) -> Path:
    """Create *path* (including parents) if it does not already exist.

    Args:
        path: Directory to create.

    Returns:
        Resolved :class:`pathlib.Path`.
    """
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    return path
