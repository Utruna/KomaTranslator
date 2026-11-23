"""KomaTranslator Live — serveur local utilisé par l'extension navigateur.

    POST /translate?src=auto&tgt=fr   (corps = octets de l'image)
      → {"width", "height", "blocks": [{box, lines, text, translation, bg, fg, solid}]}
    GET  /health
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
import time
import traceback
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import ocr  # noqa: E402
import translate  # noqa: E402

CONFIG_PATH = Path(__file__).parent / "config.json"
DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8765,
    # "google" (gratuit) | "anthropic" (Claude, meilleure qualité) | "openai" (Ollama, DeepSeek, OpenAI...)
    "provider": "google",
    "model": "",
    "api_key": "",
    "base_url": "",
}

_cache: OrderedDict[str, dict] = OrderedDict()
CACHE_MAX = 300


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")
    return {**DEFAULT_CONFIG, **json.loads(CONFIG_PATH.read_text(encoding="utf-8"))}


def process(data: bytes, src: str, tgt: str, cfg: dict) -> dict:
    key = hashlib.sha1(data).hexdigest() + f"|{src}|{tgt}|{cfg['provider']}"
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    t0 = time.time()
    img = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
    blocks = ocr.analyze(img, src)
    t1 = time.time()
    translations = translate.translate_all([b["text"] for b in blocks], src, tgt, cfg)
    for b, tr in zip(blocks, translations):
        b["translation"] = tr
    t2 = time.time()
    print(f"[{img.shape[1]}x{img.shape[0]}] {len(blocks)} bulles  ocr {t1 - t0:.1f}s  trad {t2 - t1:.1f}s", flush=True)

    result = {"width": img.shape[1], "height": img.shape[0], "blocks": blocks}
    _cache[key] = result
    if len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)
    return result


class Handler(BaseHTTPRequestHandler):
    cfg: dict = {}

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._send(200, {"ok": True, "provider": self.cfg["provider"]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/translate":
            return self._send(404, {"error": "not found"})
        q = parse_qs(url.query)
        src = q.get("src", ["auto"])[0]
        tgt = q.get("tgt", ["fr"])[0]
        try:
            data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self._send(200, process(data, src, tgt, self.cfg))
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": str(e)})

    def log_message(self, *args):  # silence les logs HTTP
        pass


def main():
    cfg = load_config()
    Handler.cfg = cfg
    print("Chargement de l'OCR...")
    ocr.warmup("auto")
    srv = ThreadingHTTPServer((cfg["host"], cfg["port"]), Handler)
    print(f"KomaTranslator Live prêt sur http://{cfg['host']}:{cfg['port']}  (traduction: {cfg['provider']})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
