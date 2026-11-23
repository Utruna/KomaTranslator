"""KomaTranslator Live — serveur local utilisé par l'extension navigateur.

    POST /translate?src=auto&tgt=fr&page=<url de la page>   (corps = octets de l'image)
      → {"width", "height", "blocks": [{box, lines, text, translation, bg, fg, patch_box, patch}]}
    GET  /series?page=<url>        → infos de la série (glossaire, résumé)
    POST /series/import            {page, wiki, src, tgt} → importe un glossaire depuis un wiki
    GET  /health
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
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
import series  # noqa: E402
import translate  # noqa: E402

CONFIG_PATH = Path(__file__).parent / "config.json"
DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8765,
    # "google" (gratuit) | "ollama" (local) | "anthropic" (Claude) | "openai" (API compatible OpenAI)
    "provider": "google",
    "review": False,  # LLM: 2e passe de relecture (orthographe, grammaire)
    "num_ctx": 8192,  # ollama: taille du contexte
    "model": "",
    "api_key": "",
    "base_url": "",
}

_cache: OrderedDict[str, dict] = OrderedDict()
CACHE_MAX = 300
CACHE_DIR = Path(__file__).parent / "cache"
DISK_CACHE_MAX = 3000

# Crédits / pubs de scantrad: ni effacés ni traduits
_CREDITS = re.compile(
    r"(https?://|www\.|\w\.(com|net|org|io|gg|me|xyz|to|cc|fr)\b|discord|patreon|ko-?fi|paypal|"
    r"\b\w+ ?scans\b|\bscantrad|read (the )?(latest|this|new|more)? ?chapters? (on|at)|"
    r"translat(or|ed by)|proofread|typeset|clean(er|ed by)|\braw provider)",
    re.I,
)


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")
    return {**DEFAULT_CONFIG, **json.loads(CONFIG_PATH.read_text(encoding="utf-8"))}


def _cache_file(key: str) -> Path:
    return CACHE_DIR / (hashlib.sha1(key.encode()).hexdigest() + ".json")


def _disk_get(key: str) -> dict | None:
    f = _cache_file(key)
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def _disk_put(key: str, result: dict) -> None:
    CACHE_DIR.mkdir(exist_ok=True)
    _cache_file(key).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    files = list(CACHE_DIR.glob("*.json"))
    if len(files) > DISK_CACHE_MAX:  # on supprime les plus anciens
        for f in sorted(files, key=lambda f: f.stat().st_mtime)[: len(files) - DISK_CACHE_MAX]:
            f.unlink(missing_ok=True)


def process(data: bytes, src: str, tgt: str, cfg: dict, page_url: str = "") -> dict:
    image_id = hashlib.sha1(data).hexdigest()
    key = f"{image_id}|{src}|{tgt}|{cfg['provider']}|{cfg.get('model', '')}|{cfg.get('review', False)}"
    skey = series.series_key(page_url)
    result = _cache.get(key) or _disk_get(key)
    if result is None:
        t0 = time.time()
        img = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
        blocks = [b for b in ocr.analyze(img, src) if not _CREDITS.search(b["text"])]
        t1 = time.time()
        texts = [b["text"] for b in blocks]
        translations = translate.translate_all(texts, src, tgt, cfg, series.context_for(skey, texts))
        for b, tr in zip(blocks, translations):
            b["translation"] = tr
        if blocks:
            series.add_history(skey, list(zip(texts, translations)))
        t2 = time.time()
        print(f"[{img.shape[1]}x{img.shape[0]}] {len(blocks)} bulles  ocr {t1 - t0:.1f}s  trad {t2 - t1:.1f}s", flush=True)
        result = {"width": img.shape[1], "height": img.shape[0], "blocks": blocks}
        _disk_put(key, result)
    _cache[key] = result
    _cache.move_to_end(key)
    if len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)
    # corrections manuelles de la série (toujours prioritaires, même sur le cache)
    fixes = series.load(skey).get("corrections", {})
    blocks = [{**b, "translation": fixes.get(b["text"], b["translation"])} for b in result["blocks"]]
    return {**result, "blocks": blocks, "image_id": image_id}


class Handler(BaseHTTPRequestHandler):
    cfg: dict = {}

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        try:
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass  # le navigateur a abandonné la requête: le résultat reste en cache pour la suivante

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/health":
            self._send(200, {"ok": True, "provider": self.cfg["provider"], "model": self.cfg.get("model", "")})
        elif url.path == "/series/full":
            key = series.series_key(parse_qs(url.query).get("page", [""])[0])
            self._send(200, series.load(key))
        elif url.path == "/series":
            key = series.series_key(parse_qs(url.query).get("page", [""])[0])
            d = series.load(key)
            self._send(200, {"key": key, "wiki": d["wiki"], "terms": len(d["glossary"]), "summary": d["summary"]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/series/import":
            return self._import()
        if url.path == "/cache/clear":
            _cache.clear()
            n = 0
            for f in CACHE_DIR.glob("*.json"):
                f.unlink(missing_ok=True)
                n += 1
            print(f"[cache] vidé ({n} pages)", flush=True)
            return self._send(200, {"ok": True, "cleared": n})
        if url.path in ("/correct", "/series/save"):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                key = series.series_key(body.get("page", ""))
                if url.path == "/correct":
                    series.set_correction(key, body["text"], body["translation"])
                else:
                    series.save_edit(key, body)
                return self._send(200, {"ok": True, "key": key})
            except Exception as e:
                traceback.print_exc()
                return self._send(500, {"error": str(e)})
        if url.path != "/translate":
            return self._send(404, {"error": "not found"})
        q = parse_qs(url.query)
        src = q.get("src", ["auto"])[0]
        tgt = q.get("tgt", ["fr"])[0]
        try:
            data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self._send(200, process(data, src, tgt, self.cfg, q.get("page", [""])[0]))
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": str(e)})

    def _import(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.cfg["provider"] == "google":
                return self._send(400, {"error": "l'import wiki nécessite un LLM (provider ollama / anthropic / openai)"})
            key = series.series_key(body.get("page", ""))
            cfg = {**self.cfg, "num_ctx": max(int(self.cfg.get("num_ctx", 8192)), 12288)}
            d = series.import_wiki(key, body["wiki"], body.get("src", "auto"), body.get("tgt", "fr"),
                                   lambda prompt: translate.llm_json(prompt, cfg), body.get("html", ""),
                                   body.get("subpages") or [], log=lambda m: print(m, flush=True))
            print(f"[wiki] {key}: {len(d['glossary'])} termes", flush=True)
            self._send(200, {"key": key, "terms": len(d["glossary"]), "summary": d["summary"]})
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"error": str(e)})

    def log_message(self, *args):  # silence les logs HTTP
        pass


def main():
    cfg = load_config()
    cfg["port"] = int(os.environ.get("KOMA_PORT", cfg["port"]))
    Handler.cfg = cfg
    print("Chargement de l'OCR...")
    ocr.warmup("auto")
    srv = ThreadingHTTPServer((cfg["host"], cfg["port"]), Handler)
    print(f"KomaTranslator Live prêt sur http://{cfg['host']}:{cfg['port']}  (traduction: {cfg['provider']})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
