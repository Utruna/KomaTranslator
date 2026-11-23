"""Traduction des blocs: Google (gratuit, sans clé), Claude, ou API compatible OpenAI (Ollama, DeepSeek...)."""
from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor

import requests

LANG_NAMES = {
    "fr": "French", "en": "English", "es": "Spanish", "de": "German", "it": "Italian",
    "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "auto": "the source language",
}


def translate_all(texts: list[str], src: str, tgt: str, cfg: dict) -> list[str]:
    if not texts:
        return []
    provider = cfg.get("provider", "google")
    try:
        if provider == "anthropic":
            return _llm_anthropic(texts, src, tgt, cfg)
        if provider == "openai":
            return _llm_openai(texts, src, tgt, cfg)
    except Exception as e:  # LLM en panne → on retombe sur Google
        print(f"[translate] {provider} a échoué ({e}), repli sur Google")
    return _google(texts, src, tgt)


# ── Google Translate (endpoint public, gratuit) ───────────────────────────

_session = requests.Session()


def _google_one(text: str, src: str, tgt: str) -> str:
    r = _session.get(
        "https://translate.googleapis.com/translate_a/single",
        params={"client": "gtx", "sl": {"zh": "zh-CN"}.get(src, src), "tl": tgt, "dt": "t", "q": text},
        timeout=15,
    )
    r.raise_for_status()
    return "".join(part[0] for part in r.json()[0] if part[0]).strip()


def _google(texts: list[str], src: str, tgt: str) -> list[str]:
    with ThreadPoolExecutor(8) as ex:
        return list(ex.map(lambda t: _safe(_google_one, t, src, tgt), texts))


def _safe(fn, text, *a):
    try:
        return fn(text, *a)
    except Exception as e:
        print(f"[translate] erreur: {e}")
        return text


# ── LLM (une seule requête par page → cohérence du contexte) ─────────────

def _prompt(texts: list[str], src: str, tgt: str) -> str:
    items = json.dumps(texts, ensure_ascii=False)
    return (
        f"You translate manhwa/manhua/manga speech bubbles from {LANG_NAMES.get(src, src)} "
        f"into natural, fluent {LANG_NAMES.get(tgt, tgt)}, like a professional scanlation team.\n"
        "The items below are the text blocks of ONE comic page, in reading order; use them as context for each other.\n"
        "OCR may contain small errors: guess the intended meaning. Keep it short (it must fit in a bubble). "
        "Sound effects → a short equivalent onomatopoeia. Keep proper names consistent.\n"
        f"Return ONLY a JSON array of exactly {len(texts)} strings, same order, no commentary.\n\n"
        f"{items}"
    )


def _parse(raw: str, n: int) -> list[str]:
    m = re.search(r"\[.*\]", raw, re.S)
    out = json.loads(m.group(0) if m else raw)
    if not isinstance(out, list) or len(out) != n:
        raise ValueError(f"réponse LLM invalide ({len(out) if isinstance(out, list) else '?'} / {n})")
    return [str(x) for x in out]


def _llm_anthropic(texts, src, tgt, cfg):
    import anthropic

    client = anthropic.Anthropic(api_key=cfg.get("api_key") or os.environ.get("ANTHROPIC_API_KEY"))
    msg = client.messages.create(
        model=cfg.get("model") or "claude-haiku-5-5",
        max_tokens=4096,
        messages=[{"role": "user", "content": _prompt(texts, src, tgt)}],
    )
    return _parse("".join(b.text for b in msg.content if b.type == "text"), len(texts))


def _llm_openai(texts, src, tgt, cfg):
    from openai import OpenAI

    client = OpenAI(
        base_url=cfg.get("base_url") or None,
        api_key=cfg.get("api_key") or os.environ.get("OPENAI_API_KEY") or "none",
    )
    resp = client.chat.completions.create(
        model=cfg["model"],
        temperature=0.3,
        messages=[{"role": "user", "content": _prompt(texts, src, tgt)}],
    )
    return _parse(resp.choices[0].message.content or "", len(texts))
