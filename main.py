"""
main.py
-------
KomaTranslator – entry point.

Instantiates every processing module from ``config.yaml`` and runs the
end-to-end translation pipeline on all images found in the configured
input directory.

Usage::

    python main.py
    python main.py --config path/to/config.yaml
    python main.py --input  path/to/single_page.jpg --output translated.jpg
"""

from __future__ import annotations

import os
os.environ['FLAGS_use_mkldnn'] = '0'

import argparse
import sys
from pathlib import Path

from src.inpainter import Inpainter
from src.ocr_engine import OCREngine
from src.pipeline import Pipeline
from src.translation_engine import TranslationEngine
from src.typesetter import Typesetter
from src.utils import ensure_dir, get_logger, load_config

logger = get_logger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Argument parsing
# ──────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="KomaTranslator – automated manga/manhua translation tool.",
    )
    parser.add_argument(
        "--config",
        default="config.yaml",
        metavar="PATH",
        help="Path to the YAML configuration file (default: config.yaml).",
    )
    parser.add_argument(
        "--input",
        default=None,
        metavar="PATH",
        help="Path to an input image or directory. Overrides config.paths.input_dir.",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="PATH",
        help=(
            "Path for the translated output image or directory.  "
            "Overrides config.paths.output_dir."
        ),
    )
    return parser.parse_args()


# ──────────────────────────────────────────────────────────────────────
# Module factory helpers
# ──────────────────────────────────────────────────────────────────────

def build_ocr(cfg: dict) -> OCREngine:
    """Instantiate :class:`~src.ocr_engine.OCREngine` from the config dict.

    TODO: Add any extra PaddleOCR kwargs here (e.g. custom model directories).
    """
    ocr_cfg = cfg.get("ocr", {})
    return OCREngine(
        engine=ocr_cfg.get("engine", "paddle-ocr"),
        language=ocr_cfg.get("language", "ch"),
        use_gpu=ocr_cfg.get("use_gpu", False),
        det_db_thresh=ocr_cfg.get("det_db_thresh", 0.3),
        rec_batch_num=ocr_cfg.get("rec_batch_num", 6),
    )


def build_translator(cfg: dict) -> TranslationEngine:
    """Instantiate :class:`~src.translation_engine.TranslationEngine` from config.

    TODO: Load the API key from an environment variable instead of the config
          file to avoid accidental secret exposure::

              import os
              api_key = os.environ.get("OPENAI_API_KEY", t_cfg.get("api_key", ""))
    """
    t_cfg = cfg.get("translation", {})
    return TranslationEngine(
        api_key=t_cfg.get("api_key", ""),
        provider=t_cfg.get("provider", "openai"),
        base_url=t_cfg.get("base_url", "http://localhost:11434/v1"),
        model=t_cfg.get("model", "gpt-4o"),
        source_language=t_cfg.get("source_language", "Chinese"),
        target_language=t_cfg.get("target_language", "French"),
        max_tokens=t_cfg.get("max_tokens", 256),
        temperature=t_cfg.get("temperature", 0.3),
    )


def build_inpainter(cfg: dict) -> Inpainter:
    """Instantiate :class:`~src.inpainter.Inpainter` from the config dict."""
    i_cfg = cfg.get("inpainting", {})
    return Inpainter(
        method=i_cfg.get("method", "lama"),
        model_path=i_cfg.get("model_path", "models/lama"),
        device=i_cfg.get("device", "cpu"),
        opencv_method=i_cfg.get("opencv_method", "telea"),
        dilation_kernel=i_cfg.get("dilation_kernel", 5),
    )


def build_typesetter(cfg: dict) -> Typesetter:
    """Instantiate :class:`~src.typesetter.Typesetter` from the config dict.

    TODO: Add a font-discovery step that searches ``config.paths.font_dir``
          for the best matching font when ``font_path`` is not set explicitly.
    """
    ts_cfg = cfg.get("typesetting", {})
    font_color_raw = ts_cfg.get("font_color", [0, 0, 0])
    stroke_color_raw = ts_cfg.get("stroke_color", [255, 255, 255])
    return Typesetter(
        font_path=ts_cfg.get("font_path", "src/police/animeace2bb_tt/animeace2_reg.ttf"),
        font_size=ts_cfg.get("font_size", 120),
        font_color=tuple(font_color_raw),        # type: ignore[arg-type]
        line_spacing=ts_cfg.get("line_spacing", 6),
        max_font_size=ts_cfg.get("max_font_size", 200),
        min_font_size=ts_cfg.get("min_font_size", 12),
        stroke_width=ts_cfg.get("stroke_width", 1),
        stroke_color=tuple(stroke_color_raw),    # type: ignore[arg-type]
    )


def build_pipeline(cfg: dict, ocr: OCREngine, translator: TranslationEngine, inpainter: Inpainter, typesetter: Typesetter) -> Pipeline:
    """Instantiate :class:`~src.pipeline.Pipeline` from the config dict."""
    pipeline_cfg = cfg.get("pipeline", {})
    return Pipeline(
        ocr,
        translator,
        inpainter,
        typesetter,
        min_confidence=pipeline_cfg.get("min_confidence", 0.4),
        cluster_threshold=pipeline_cfg.get("cluster_threshold", 0.8),
        max_cluster_distance_px=pipeline_cfg.get("max_cluster_distance_px", 80),
    )


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────

def main() -> int:
    args = _parse_args()

    # 1. Load configuration
    try:
        cfg = load_config(args.config)
    except FileNotFoundError as exc:
        logger.error("%s", exc)
        return 1

    paths_cfg = cfg.get("paths", {})

    # 2. Instantiate modules
    logger.info("Initialising OCR engine …")
    ocr = build_ocr(cfg)

    logger.info("Initialising translation engine …")
    translator = build_translator(cfg)

    logger.info("Initialising inpainter …")
    inpainter = build_inpainter(cfg)

    logger.info("Initialising typesetter …")
    typesetter = build_typesetter(cfg)

    # 3. Assemble pipeline
    pipeline = build_pipeline(cfg, ocr, translator, inpainter, typesetter)

    # 4. Run
    if args.input:
        input_path = Path(args.input)
        if input_path.is_dir():
            # ── Batch mode (override input directory) ────────────────
            output_dir = Path(args.output) if args.output else Path(paths_cfg.get("output_dir", "output"))
            pipeline.process_directory(input_path, output_dir)
        else:
            # ── Single-file mode ─────────────────────────────────────
            if args.output:
                out = Path(args.output)
                # Treat as a directory when it already is one or the path ends
                # with a separator (e.g. `--output output/`).
                if out.is_dir() or str(args.output).endswith(("/", "\\")):
                    output_path = out / input_path.name
                else:
                    output_path = out
            else:
                output_path = Path(paths_cfg.get("output_dir", "output")) / input_path.name
            ensure_dir(output_path.parent)
            pipeline.process_file(input_path, output_path)
    else:
        # ── Batch mode (entire input directory) ──────────────────────
        input_dir = Path(paths_cfg.get("input_dir", "input"))
        output_dir = Path(paths_cfg.get("output_dir", "output"))
        pipeline.process_directory(input_dir, output_dir)

    logger.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
