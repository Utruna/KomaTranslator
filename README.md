# KomaTranslator

*Automated pipeline that takes a raw manga page as input and outputs the same page with the original text erased and replaced by the translation — no manual editing required.*

![Python](https://img.shields.io/badge/python-3.10%2B-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![LLM](https://img.shields.io/badge/LLM-OpenAI%20%7C%20Anthropic%20%7C%20DeepSeek%20%7C%20Ollama-purple) ![Inpainting](https://img.shields.io/badge/inpainting-LaMa%20%7C%20OpenCV-orange)

---

## Demo

| Before | After |
|--------|-------|
| ![Before](assets/demo_before.jpg) | ![After](assets/demo_after.jpg) |

*→ Place your before/after images in `assets/` to populate this section.*

---

## How it works

1. 🔍 **OCR** (`ocr_engine.py`) — Detects text regions on the page and extracts each string with its bounding polygon and confidence score, via the Koharu headless API (comic-text-detector + manga-ocr).
2. 🌐 **Translation** (`translation_engine.py`) — Sends each bubble's text to an LLM (OpenAI, Anthropic, DeepSeek, or a local Ollama model) using prompts tuned for manga dialogue, SFX, and UI elements.
3. 🧹 **Inpainting** (`inpainter.py`) — Erases the original text from each region using LaMa (deep-learning) or OpenCV Telea/NS as a CPU fallback.
4. ✍️ **Typesetting** (`typesetter.py`) — Renders the translated text into the cleaned bubbles with automatic font-size fitting, smart line wrapping, and configurable outline (Pillow).

---

## Installation

```bash
git clone https://github.com/Utruna/KomaTranslator.git
cd KomaTranslator
python -m venv venv && source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**Running locally without an API key?** Set `provider: openai` and point `base_url` to your Ollama instance (`http://localhost:11434/v1`). No key required — Ollama accepts any non-empty string as `api_key`.

---

## Quick Start

Edit `config.yaml` (minimum required fields):

```yaml
translation:
  api_key: "ollama"
  provider: "openai"
  base_url: "http://localhost:11434/v1"
  model: "llama3.1"
  source_language: "Chinese"
  target_language: "French"

inpainting:
  method: "lama"
  device: "cpu"
  model_path: "models/lama"
```

Then run:

```bash
# Translate a single image
python main.py --input page.jpg --output translated.jpg

# Translate a folder of images
python main.py --config config.yaml --input input/ --output output/
```

---

## Supported LLM Providers

| Provider | Model example | Config value |
|----------|--------------|--------------|
| OpenAI | `gpt-4o` | `provider: openai` |
| Anthropic (Claude) | `claude-sonnet-4-6` | `provider: anthropic` |
| DeepSeek | `deepseek-chat` | `provider: deepseek` |
| Ollama (local) | `llama3.1`, `qwen2.5` | `provider: openai` + `base_url: http://localhost:11434/v1` |

---

## Project Structure

```text
KomaTranslator/
├── config.yaml               # Centralised configuration (paths, LLM, inpainting, typesetting)
├── main.py                   # CLI entry point
├── requirements.txt          # Python dependencies
├── assets/                   # Demo images (before/after screenshots)
├── fonts/                    # TTF/OTF font files for typesetting
├── input/                    # Source images to translate
├── output/                   # Translated images written here
├── models/                   # Locally cached model weights (LaMa, etc.)
└── src/
    ├── ocr_engine.py         # Text detection and recognition (Koharu API)
    ├── translation_engine.py # LLM-backed translation, multi-provider
    ├── inpainter.py          # Text erasure — LaMa or OpenCV
    ├── typesetter.py         # Renders translated text into cleaned bubbles
    ├── pipeline.py           # Orchestrates OCR → translate → inpaint → typeset
    └── utils.py              # Logger, image I/O helpers, config loader
```

---

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `paths.input_dir` | `input` | Folder containing source images |
| `paths.output_dir` | `output` | Folder for translated output |
| `paths.font_dir` | `fonts` | Folder for TTF/OTF fonts |
| `paths.model_dir` | `models` | Folder for cached model weights |
| `translation.provider` | `openai` | LLM provider (`openai`, `anthropic`, `deepseek`) |
| `translation.model` | `llama3.1` | Model identifier passed to the provider |
| `translation.base_url` | `http://localhost:11434/v1` | API base URL (override for Ollama/custom) |
| `translation.source_language` | `Chinese` | Source language label sent to the LLM |
| `translation.target_language` | `French` | Target language label sent to the LLM |
| `translation.temperature` | `0.3` | Sampling temperature (lower = more stable) |
| `translation.max_tokens` | `256` | Max tokens in LLM response |
| `inpainting.method` | `lama` | `lama` (deep-learning) or `opencv` (CPU fallback) |
| `inpainting.device` | `cpu` | `cpu` or `cuda` |
| `inpainting.opencv_method` | `telea` | `telea` or `ns` when method is `opencv` |
| `inpainting.dilation_kernel` | `5` | Pixels added around text mask before inpainting |
| `typesetting.font_path` | *(see config)* | Path to the TTF/OTF font file |
| `typesetting.font_size` | `40` | Base font size in points |
| `typesetting.max_font_size` | `120` | Upper bound for auto-size fitting |
| `typesetting.min_font_size` | `10` | Lower bound for auto-size fitting |
| `typesetting.stroke_width` | `1` | Outline width in pixels (`0` = no outline) |
| `typesetting.line_spacing` | `6` | Extra pixels between lines |
| `pipeline.cluster_threshold` | `0.8` | Proximity factor for grouping text boxes into bubbles |
| `pipeline.max_cluster_distance_px` | `80` | Hard pixel cap — boxes farther apart are never merged |
| `pipeline.min_confidence` | `0.4` | Minimum OCR confidence to process a text box |

---

## Roadmap

- [x] End-to-end pipeline (OCR → translate → inpaint → typeset)
- [x] LaMa deep-learning inpainting
- [x] Multi-provider LLM support (OpenAI, Anthropic, DeepSeek, Ollama)
- [x] Per-bubble clustering and translation
- [x] Context-aware translation (previous bubbles passed as context)
- [ ] Vertical text support (Japanese manga)
- [ ] Batch API support (Anthropic) for cost reduction
- [ ] Web UI / drag-and-drop interface
- [ ] Multi-language OCR (Japanese, Korean)

---

## Contributing

PRs are welcome. For significant changes, please open an issue first to discuss the approach.
→ [Open an issue](https://github.com/Utruna/KomaTranslator/issues)

## License

MIT
