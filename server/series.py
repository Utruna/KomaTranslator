"""Mémoire par série: glossaire (noms, sorts, lieux...), résumé, dernières répliques traduites."""
from __future__ import annotations

import html
import json
import re
import threading
from pathlib import Path
from urllib.parse import urlparse

import requests

DIR = Path(__file__).parent / "series"
HISTORY_MAX = 30
_lock = threading.Lock()

_CHAPTER = re.compile(r"(chap|chapter|chapitre|episode|ep[-_]?\d|ch[-_.]?\d|^\d+$|^c\d+$|viewer|read)", re.I)


def series_key(page_url: str) -> str:
    """site.com/manga/ma-serie/chapitre-12 → site.com/manga/ma-serie"""
    if not page_url:
        return "inconnu"
    u = urlparse(page_url)
    kept = []
    for seg in [s for s in u.path.split("/") if s]:
        if _CHAPTER.search(seg):
            break
        kept.append(seg)
    return "/".join([u.hostname or "local", *kept[:3]])


def _path(key: str) -> Path:
    return DIR / (re.sub(r"[^\w.-]+", "_", key)[:120] + ".json")


def load(key: str) -> dict:
    p = _path(key)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"key": key, "wiki": "", "summary": "", "glossary": [], "history": []}


def save(data: dict) -> None:
    DIR.mkdir(exist_ok=True)
    _path(data["key"]).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def set_correction(key: str, text: str, translation: str) -> None:
    with _lock:
        data = load(key)
        data.setdefault("corrections", {})[text] = translation
        save(data)


def save_edit(key: str, body: dict) -> None:
    """Sauvegarde depuis l'éditeur de l'extension (glossaire, résumé, corrections)."""
    with _lock:
        data = load(key)
        if "glossary" in body:
            data["glossary"] = [
                {k: str(t.get(k, "") or "") for k in ("src", "orig", "tgt", "type", "note")}
                for t in body["glossary"] if t.get("src") and t.get("tgt")
            ]
        if "summary" in body:
            data["summary"] = str(body["summary"])
        if "corrections" in body:
            data["corrections"] = {str(k): str(v) for k, v in body["corrections"].items() if k and v}
        if body.get("clear_history"):
            data["history"] = []
        save(data)


def add_history(key: str, pairs: list[tuple[str, str]]) -> None:
    with _lock:
        data = load(key)
        data["history"] = (data["history"] + [list(p) for p in pairs])[-HISTORY_MAX:]
        save(data)


def context_for(key: str, texts: list[str]) -> dict:
    """Ce qu'on envoie au LLM: termes du glossaire + résumé + historique récent."""
    data = load(key)
    page = "\n".join(texts).lower()
    terms = data["glossary"]
    if len(terms) > 60:  # gros glossaire: seulement les termes présents dans la page
        terms = [t for t in terms if any(t.get(k) and t[k].lower() in page for k in ("orig", "src"))]
    return {"summary": data["summary"], "terms": terms, "history": data["history"][-12:]}


# ── Import depuis un wiki ─────────────────────────────────────────────────

def wiki_text(url: str, page_html: str = "", limit: int = 14000) -> str:
    """Texte lisible de la page wiki. page_html = HTML déjà récupéré par le navigateur (prioritaire)."""
    s = page_html
    if not s:
        r = requests.get(url, timeout=20, headers={"User-Agent": "KomaTranslator/1.0 (outil perso de traduction)"})
        r.raise_for_status()
        s = r.text
    # le contenu principal d'un wiki (MediaWiki / Fandom) est dans #mw-content-text
    m = re.search(r'(?is)id="mw-content-text".*', s)
    if m:
        s = m.group(0)
    s = re.sub(r"(?is)<(script|style|noscript|nav|footer|header|aside)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()[:limit]


def _extract_prompt(text: str, src: str, tgt: str, with_summary: bool) -> str:
    from translate import LANG_NAMES

    S, T = LANG_NAMES.get(src, src), LANG_NAMES.get(tgt, tgt)
    lines = [
        "Below is text from wiki pages about a comic (manhua / manhwa / manga).",
        f"Build a translation glossary for translating this comic from {S} into {T}.",
        "Include: character names, places, organizations, techniques / spells / skills, ranks / cultivation levels, "
        "items, monsters, classes. Skip wiki navigation, chapter lists, staff / publisher info.",
        '- "src": the term as written in the wiki',
        '- "orig": the term in the comic\'s original script (Chinese characters / Hangul / Kana); use your own '
        "knowledge of the series if the wiki only gives a romanization; empty if unsure",
        f'- "tgt": the rendering to use IN {T.upper()} (translate common words like Academy / Sect / Tribe / King / '
        "Sword into that language; keep personal names romanized)",
        '- "type": character | place | technique | rank | organization | item | creature | other',
        "- \"note\": very short (gender for characters: 'male' / 'female')",
    ]
    if with_summary:
        lines.append('Also write "summary": 3-5 sentences: premise + main characters with gender and relationships.')
    lines.append(
        "Answer ONLY with JSON: {" + ('"summary": "...", ' if with_summary else "")
        + '"terms": [{"src": "...", "orig": "...", "tgt": "...", "type": "...", "note": "..."}]}'
    )
    lines += ["", "WIKI TEXT:", text]
    return "\n".join(lines)


def import_wiki(key: str, url: str, src: str, tgt: str, llm, page_html: str = "",
                subpages: list[dict] | None = None, log=print) -> dict:
    """Extrait un glossaire de la page wiki (+ sous-pages) et le fusionne avec l'existant.

    llm(prompt) -> dict JSON. subpages = [{"url", "html"}] récupérées par le navigateur.
    """
    # 1er lot: la page principale (avec résumé). Lots suivants: sous-pages regroupées (~10 000 caractères).
    chunks = [wiki_text(url, page_html, limit=12000)]
    cur = ""
    for sp in subpages or []:
        try:
            t = wiki_text(sp["url"], sp.get("html", ""), limit=4000)
        except Exception:
            continue
        if cur and len(cur) + len(t) > 10000:
            chunks.append(cur)
            cur = ""
        cur += f"\n=== {sp['url'].rsplit('/', 1)[-1]} ===\n{t}"
    if cur:
        chunks.append(cur)

    terms, summary, errors = [], "", []
    for i, text in enumerate(chunks):
        log(f"[wiki] lot {i + 1}/{len(chunks)}…")
        try:
            out = llm(_extract_prompt(text, src, tgt, with_summary=(i == 0)))
        except Exception as e:
            errors.append(str(e))
            log(f"[wiki] lot {i + 1} en échec: {e}")
            continue
        if not isinstance(out, dict):
            continue
        if i == 0:
            summary = out.get("summary", "") or ""
        terms += [t for t in out.get("terms", []) if isinstance(t, dict) and t.get("src") and t.get("tgt")]
    if not terms and errors:
        raise RuntimeError("extraction impossible: " + errors[0])

    with _lock:
        data = load(key)
        known = {t["src"].lower(): t for t in data["glossary"]}
        for t in terms:
            known[str(t["src"]).lower()] = {k: str(t.get(k, "") or "") for k in ("src", "orig", "tgt", "type", "note")}
        data["glossary"] = list(known.values())
        data["summary"] = summary or data["summary"]
        data["wiki"] = url
        save(data)
    return data
