"""OCR: PaddleOCR PP-OCRv5 (mobile) + regroupement des lignes en bulles."""
from __future__ import annotations

import os
import re
import threading

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import base64

import cv2
import numpy as np

# Modèle de reconnaissance selon la langue source.
# PP-OCRv5 "standard" lit chinois (simplifié + traditionnel), anglais et japonais.
REC_MODELS = {
    "auto": "PP-OCRv5_mobile_rec",
    "zh": "PP-OCRv5_mobile_rec",
    "ja": "PP-OCRv5_mobile_rec",
    "en": "en_PP-OCRv5_mobile_rec",
    "ko": "korean_PP-OCRv5_mobile_rec",
}

TILE_H = 1600      # hauteur max d'une tranche (webtoons très longs)
TILE_OVERLAP = 240
MIN_SCORE = 0.6

_engines: dict[str, object] = {}
_engines_lock = threading.Lock()
_run_lock = threading.Lock()  # paddle n'aime pas l'inférence concurrente


def _engine(lang: str):
    model = REC_MODELS.get(lang, REC_MODELS["auto"])
    with _engines_lock:
        if model not in _engines:
            from paddleocr import PaddleOCR

            _engines[model] = PaddleOCR(
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name=model,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=False,  # bug oneDNN dans paddle 3.3 sous Windows
                text_det_limit_side_len=1600,
                text_det_limit_type="max",
            )
        return _engines[model]


def warmup(lang: str = "auto") -> None:
    eng = _engine(lang)
    with _run_lock:
        eng.predict(np.full((64, 256, 3), 255, np.uint8))


# ── Détection + reconnaissance ────────────────────────────────────────────

def _tiles(h: int):
    if h <= TILE_H:
        yield 0, h
        return
    y = 0
    while True:
        y1 = min(y + TILE_H, h)
        yield y, y1
        if y1 >= h:
            return
        y = y1 - TILE_OVERLAP


def read_lines(img: np.ndarray, lang: str) -> list[dict]:
    """Retourne les lignes de texte: {box:[x0,y0,x1,y1], text, score}."""
    eng = _engine(lang)
    h = img.shape[0]
    lines: list[dict] = []
    for y0, y1 in _tiles(h):
        tile = np.ascontiguousarray(img[y0:y1])
        with _run_lock:
            res = eng.predict(tile)[0]
        first, last = y0 == 0, y1 >= h
        for text, score, box in zip(res["rec_texts"], res["rec_scores"], res["rec_boxes"]):
            bx0, by0, bx1, by1 = (int(v) for v in box)
            # lignes coupées par le bord d'une tranche: une autre tranche les verra entières
            if (not first and by0 <= 3) or (not last and by1 >= (y1 - y0) - 3):
                continue
            box_abs = [bx0, by0 + y0, bx1, by1 + y0]
            if any(_iou(box_abs, l["box"]) > 0.4 for l in lines):
                continue
            lines.append({"box": box_abs, "text": text.strip(), "score": float(score)})
    return [l for l in lines if _keep(l)]


_MEANINGFUL = re.compile(r"[\w぀-ヿ㐀-鿿가-힯]", re.UNICODE)


def _keep(line: dict) -> bool:
    t = line["text"]
    if line["score"] < MIN_SCORE or not t:
        return False
    if not _MEANINGFUL.search(t):
        return False
    # un seul caractère latin/chiffre isolé = bruit
    if len(t) == 1 and t.isascii():
        return False
    return True


def _iou(a, b) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter == 0:
        return 0.0
    area = lambda r: (r[2] - r[0]) * (r[3] - r[1])
    return inter / min(area(a), area(b))


# ── Regroupement lignes → bulles ──────────────────────────────────────────

def _vertical(l: dict) -> bool:
    x0, y0, x1, y1 = l["box"]
    return (y1 - y0) > 1.5 * (x1 - x0) and len(l["text"]) >= 2


def _same_block(a: dict, b: dict) -> bool:
    va, vb = _vertical(a), _vertical(b)
    if va != vb:
        return False
    if va:  # colonnes verticales (manga japonais): on transpose le problème
        a = {"box": [a["box"][1], a["box"][0], a["box"][3], a["box"][2]]}
        b = {"box": [b["box"][1], b["box"][0], b["box"][3], b["box"][2]]}
    ax0, ay0, ax1, ay1 = a["box"]
    bx0, by0, bx1, by1 = b["box"]
    ha, hb = ay1 - ay0, by1 - by0
    if max(ha, hb) > 1.7 * min(ha, hb):  # tailles de police trop différentes
        return False
    lh = (ha + hb) / 2
    vgap = max(by0 - ay1, ay0 - by1)
    if vgap > 0.9 * lh:
        return False
    overlap = min(ax1, bx1) - max(ax0, bx0)
    if overlap > 0:
        return True
    if va:
        return False
    # lignes centrées dans une bulle: centres proches horizontalement
    acx, bcx = (ax0 + ax1) / 2, (bx0 + bx1) / 2
    return abs(acx - bcx) < 1.5 * lh and vgap > -0.5 * lh


def group_blocks(lines: list[dict]) -> list[list[dict]]:
    n = len(lines)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if _same_block(lines[i], lines[j]):
                parent[find(i)] = find(j)

    groups: dict[int, list[dict]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(lines[i])
    blocks = [
        sorted(g, key=lambda l: -l["box"][2]) if _vertical(g[0])  # colonnes: droite → gauche
        else sorted(g, key=lambda l: l["box"][1])
        for g in groups.values()
    ]
    blocks.sort(key=lambda g: (g[0]["box"][1], g[0]["box"][0]))
    return blocks


_CJK = re.compile(r"[぀-ヿ㐀-鿿＀-￯　-〿]")


def join_lines(texts: list[str]) -> str:
    out = ""
    for t in texts:
        if out and not (_CJK.match(out[-1]) and _CJK.match(t[0])):
            out += " "
        out += t
    return out


# ── Couleurs + effacement du texte ────────────────────────────────────────

def _ring(img, x0, y0, x1, y1, pad):
    h, w = img.shape[:2]
    X0, Y0, X1, Y1 = max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)
    return np.concatenate([
        img[Y0:Y0 + 2, X0:X1].reshape(-1, 3), img[Y1 - 2:Y1, X0:X1].reshape(-1, 3),
        img[Y0:Y1, X0:X0 + 2].reshape(-1, 3), img[Y0:Y1, X1 - 2:X1].reshape(-1, 3),
    ]).astype(np.int16)


def _hex(c) -> str:
    return "#%02x%02x%02x" % tuple(int(v) for v in c)


def clean_block(img: np.ndarray, line_boxes: list[list[int]]) -> tuple[list[int], str, str, str]:
    """Efface le texte (inpainting sur les pixels du texte uniquement).

    Retourne (patch_box, patch_png_base64, couleur_fond, couleur_texte).
    """
    h, w = img.shape[:2]
    xs0, ys0, xs1, ys1 = zip(*line_boxes)
    ctx = 12
    X0, Y0 = max(0, min(xs0) - ctx), max(0, min(ys0) - ctx)
    X1, Y1 = min(w, max(xs1) + ctx), min(h, max(ys1) + ctx)
    crop = np.ascontiguousarray(img[Y0:Y1, X0:X1])
    mask = np.zeros(crop.shape[:2], np.uint8)
    bgs, fgs = [], []
    for x0, y0, x1, y1 in line_boxes:
        bg = np.median(_ring(img, x0, y0, x1, y1, 3), axis=0)
        a0, b0 = max(0, x0 - 3 - X0), max(0, y0 - 3 - Y0)
        a1, b1 = min(crop.shape[1], x1 + 3 - X0), min(crop.shape[0], y1 + 3 - Y0)
        reg = crop[b0:b1, a0:a1].astype(np.int16)
        dist = np.abs(reg - bg).sum(axis=2)
        mask[b0:b1, a0:a1] |= (dist > 35).astype(np.uint8) * 255
        far = reg[dist > np.percentile(dist, 85)]
        bgs.append(bg)
        if len(far):
            fgs.append(np.median(far, axis=0))
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=3)
    clean = cv2.inpaint(crop[:, :, ::-1], mask, 5, cv2.INPAINT_TELEA)[:, :, ::-1]
    ok, png = cv2.imencode(".png", clean[:, :, ::-1])

    bg = np.median(bgs, axis=0)
    fg = np.median(fgs, axis=0) if fgs else 255 - bg
    if np.abs(fg - bg).sum() < 150:  # contraste insuffisant → noir/blanc
        fg = np.array([0, 0, 0]) if bg.mean() > 127 else np.array([255, 255, 255])
    return [X0, Y0, X1, Y1], base64.b64encode(png.tobytes()).decode(), _hex(bg), _hex(fg)


def analyze(img: np.ndarray, lang: str) -> list[dict]:
    """Image RGB → blocs de texte prêts à traduire + patchs nettoyés."""
    lines = read_lines(img, lang)
    blocks = []
    for group in group_blocks(lines):
        boxes = [l["box"] for l in group]
        xs0, ys0, xs1, ys1 = zip(*boxes)
        patch_box, patch, bg, fg = clean_block(img, boxes)
        blocks.append({
            "box": [min(xs0), min(ys0), max(xs1), max(ys1)],
            "lines": boxes,
            "text": join_lines([l["text"] for l in group]),
            "bg": bg,
            "fg": fg,
            "patch_box": patch_box,
            "patch": patch,
        })
    return blocks
