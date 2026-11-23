"""Traduction des blocs: Google (gratuit), Ollama (local), Claude, ou API compatible OpenAI."""
from __future__ import annotations

import json
from difflib import SequenceMatcher
import os
import re
from concurrent.futures import ThreadPoolExecutor

import requests

LANG_NAMES = {
    "fr": "French", "en": "English", "es": "Spanish", "de": "German", "it": "Italian",
    "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "auto": "the source language",
}


_LATIN = re.compile(r"[A-Za-zÀ-ÿ]")


def _decaps(text: str, names: list[str]) -> str:
    """'DIE, YE WUXIAN!' → 'Die, Ye Wuxian!' : les LLM traduisent mal le texte tout en majuscules."""
    letters = _LATIN.findall(text)
    if len(letters) < 4 or sum(c.isupper() for c in letters) < 0.8 * len(letters):
        return text
    out = text.lower()
    out = re.sub(r"(^|[.!?…]\s+|^[\"'«(\s]+)([a-zà-ÿ])", lambda m: m.group(1) + m.group(2).upper(), out)
    out = re.sub(r"\bi\b", "I", out)
    out = re.sub(r"\bi'", "I'", out)
    for n in names:  # noms propres connus (glossaire)
        if n and _LATIN.search(n):
            out = re.sub(r"\b" + re.escape(n) + r"\b", n, out, flags=re.I)
    return out


def translate_all(texts: list[str], src: str, tgt: str, cfg: dict, ctx: dict | None = None) -> list[str]:
    if not texts:
        return []
    names = [t.get("src", "") for t in (ctx or {}).get("terms", [])]
    decapped = [_decaps(t, names) for t in texts]
    ctx = {**(ctx or {}), "lowercased": decapped != texts}
    texts = decapped
    if cfg.get("provider", "google") != "google":
        try:
            out = llm_json(_prompt(texts, src, tgt, ctx or {}), cfg)
            if isinstance(out, dict) and isinstance(out.get("translations"), dict):
                out = out["translations"]
            if not isinstance(out, dict):
                raise ValueError("réponse LLM invalide")
            missing = [i for i in range(len(texts)) if str(i + 1) not in out]
            if len(missing) > len(texts) // 2:
                raise ValueError(f"réponse LLM incomplète ({len(texts) - len(missing)} / {len(texts)})")
            fallback = _google([texts[i] for i in missing], src, tgt) if missing else []
            fb = dict(zip(missing, fallback))
            result = [str(out[str(i + 1)]) if i not in fb else fb[i] for i in range(len(texts))]
            if cfg.get("review"):
                result = _review(texts, result, src, tgt, cfg)
            return result
        except Exception as e:  # LLM en panne → on retombe sur Google
            print(f"[translate] {cfg['provider']} a échoué ({e}), repli sur Google", flush=True)
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
    def one(t):
        try:
            return _google_one(t, src, tgt)
        except Exception as e:
            print(f"[translate] erreur: {e}")
            return t

    with ThreadPoolExecutor(8) as ex:
        return list(ex.map(one, texts))


# ── LLM: une requête par page, avec le contexte de la série ──────────────

def _prompt(texts: list[str], src: str, tgt: str, ctx: dict) -> str:
    s, t = LANG_NAMES.get(src, src), LANG_NAMES.get(tgt, tgt)
    parts = [
        f"You translate manhwa/manhua/manga speech bubbles from {s} into natural, fluent {t}, "
        "like a professional scanlation team.",
        "Rules:",
        "- The items are the text blocks of ONE comic page, in reading order: use them as context for each other.",
        "- Write natural spoken dialogue with properly conjugated verbs (never telegraphic or infinitive-style).",
        "- OCR may contain small errors: guess the intended meaning.",
        "- Always translate everything, including short interjections. Keep stutters, e.g. 'H-help!' → 'À-à l'aide !', "
        "'W-what?' → 'Q-quoi ?'.",
        "- Commands shouted at someone stay imperatives addressed to that person ('Die!' → 'Meurs !').",
        "- Adapt interjections to the target language instead of copying them "
        "(e.g. in French: 'Yeah!' → 'Ouais !', battle cry 'Yah!/Haa!' → 'Haaa !', 'Huh?' → 'Hein ?', 'Ugh' → 'Argh').",
        "- Keep it concise (it must fit in a bubble). Sound effects → a short onomatopoeia.",
        "- Keep names and terms consistent with the glossary and previous lines.",
        "- Each item is a separate bubble: translate it in place, never move words from one item to another, "
        "even if a sentence continues in the next item.",
    ]
    if ctx.get("lowercased"):
        parts.append("- The source was in ALL CAPS and was lowercased automatically: some proper names may appear "
                     "in lowercase (e.g. 'ye wuxian'). Recognize them and keep them as capitalized names.")
    if ctx.get("summary"):
        parts += ["", "STORY CONTEXT:", ctx["summary"]]
    if ctx.get("terms"):
        parts += ["", f"GLOSSARY (always use these {t} renderings):"]
        for g in ctx["terms"]:
            note = ", ".join(x for x in (g.get("type"), g.get("note")) if x)
            names = " / ".join(x for x in (g.get("orig"), g.get("src")) if x)
            parts.append(f"- {names} → {g['tgt']}" + (f" ({note})" if note else ""))
    if ctx.get("history"):
        parts += ["", "PREVIOUS LINES (already translated, most recent last):"]
        parts += [f"- {a} → {b}" for a, b in ctx["history"]]
    parts += [
        "",
        "Answer ONLY with a JSON object mapping each item number to its translation, "
        f'e.g. {{"1": "...", "2": "..."}} — all {len(texts)} numbers, each translation in its own number.',
        "",
        "ITEMS:",
        json.dumps({str(i + 1): t for i, t in enumerate(texts)}, ensure_ascii=False, indent=0),
    ]
    return "\n".join(parts)


def _extract_json(raw: str):
    raw = re.sub(r"(?s)<think>.*?</think>", "", raw).strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}|\[.*\]", raw, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def llm_json(prompt: str, cfg: dict):
    """Envoie le prompt au LLM configuré et renvoie le JSON parsé."""
    provider = cfg["provider"]
    if provider == "ollama":
        base = (cfg.get("base_url") or "http://localhost:11434").rstrip("/").removesuffix("/v1")
        r = requests.post(f"{base}/api/chat", timeout=300, json={
            "model": cfg["model"],
            "messages": [{"role": "user", "content": prompt}],
            "format": "json",
            "stream": False,
            "think": False,
            "keep_alive": "30m",
            "options": {"temperature": 0.3, "num_ctx": int(cfg.get("num_ctx", 8192))},
        })
        r.raise_for_status()
        return _extract_json(r.json()["message"]["content"])

    if provider == "anthropic":
        import anthropic

        client = anthropic.Anthropic(api_key=cfg.get("api_key") or os.environ.get("ANTHROPIC_API_KEY"))
        msg = client.messages.create(
            model=cfg.get("model") or "claude-haiku-5-5",
            max_tokens=8192,
            messages=[{"role": "user", "content": prompt}],
        )
        return _extract_json("".join(b.text for b in msg.content if b.type == "text"))

    if provider == "openai":
        from openai import OpenAI

        client = OpenAI(
            base_url=cfg.get("base_url") or None,
            api_key=cfg.get("api_key") or os.environ.get("OPENAI_API_KEY") or "none",
        )
        resp = client.chat.completions.create(
            model=cfg["model"],
            temperature=0.3,
            messages=[{"role": "user", "content": prompt}],
        )
        return _extract_json(resp.choices[0].message.content or "")

    raise ValueError(f"provider inconnu: {provider}")


def _norm(t: str) -> str:
    return re.sub(r"\W+", "", t).lower()


def _review(texts: list[str], drafts: list[str], src: str, tgt: str, cfg: dict) -> list[str]:
    """2e passe: le LLM relit ses traductions (orthographe, conjugaison, contresens)."""
    T = LANG_NAMES.get(tgt, tgt)
    pairs = {str(i + 1): {"source": s, "draft": d} for i, (s, d) in enumerate(zip(texts, drafts))}
    prompt = "\n".join([
        f"You are proofreading a {T} translation of comic speech bubbles.",
        f"For each item, fix spelling, grammar, conjugation, accents and mistranslations in the {T} draft "
        "(compare with the source: e.g. a command shouted at someone must stay an imperative).",
        "Check every word carefully (French conjugation: je vais, il vaudra...). Keep the style and length.",
        'Answer ONLY with a JSON object mapping each item number to the corrected text as a plain string, '
        'e.g. {"1": "corrected text", "2": "..."}.',
        "",
        json.dumps(pairs, ensure_ascii=False, indent=0),
    ])
    try:
        out = llm_json(prompt, cfg)
        if isinstance(out, dict) and isinstance(out.get("translations"), dict):
            out = out["translations"]
        if not isinstance(out, dict):
            return drafts
        fixed = []
        for i, d in enumerate(drafts):
            v = out.get(str(i + 1))
            if isinstance(v, dict):  # le modèle a recopié l'objet: on prend le champ texte
                v = v.get("corrected") or v.get("text") or v.get("draft")
            ok = isinstance(v, str) and v.strip()
            # relecture = petites corrections seulement: on refuse les réécritures et les copies de la source
            if ok and (SequenceMatcher(None, v.lower(), d.lower()).ratio() < 0.7
                       or _norm(v) == _norm(texts[i])):
                ok = False
            fixed.append(v if ok else d)
        return fixed
    except Exception as e:
        print(f"[translate] relecture échouée ({e})", flush=True)
        return drafts
