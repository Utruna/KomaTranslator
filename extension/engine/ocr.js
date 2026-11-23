// KomaTranslator — OCR dans le navigateur
// PP-OCRv5 (ONNX Runtime Web / WebAssembly) + regroupement en bulles + effacement du texte.
// Portage JS de server/ocr.py (mêmes modèles et mêmes réglages que RapidOCR).
/* global ort */
(() => {
  const TILE_H = 1600;     // hauteur max d'une tranche (webtoons très longs)
  const OVERLAP = 240;
  const DET_LIMIT = 1600;  // côté max envoyé au détecteur
  const MIN_SCORE = 0.6;
  const REC_H = 48;

  const base = () => chrome.runtime.getURL("engine/");
  let ortReady = null;
  const sessions = {};
  const dicts = {};

  function initOrt() {
    if (!ortReady) {
      ortReady = Promise.resolve().then(() => {
        ort.env.wasm.wasmPaths = base();
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        ort.env.wasm.proxy = false;
        ort.env.logLevel = "error";
      });
    }
    return ortReady;
  }

  function session(name) {
    if (!sessions[name]) {
      sessions[name] = initOrt().then(() =>
        ort.InferenceSession.create(base() + "models/" + name + ".onnx", {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        }));
    }
    return sessions[name];
  }

  async function dict(name, nClasses) {
    if (!dicts[name]) {
      const txt = await (await fetch(base() + "models/" + name + ".txt")).text();
      const lines = txt.split(/\r?\n/);
      while (lines.length > nClasses - 2 && lines[lines.length - 1] === "") lines.pop();
      dicts[name] = ["", ...lines, " "]; // 0 = blank CTC, dernier = espace
    }
    return dicts[name];
  }

  const REC_MODEL = { auto: "rec_ch", zh: "rec_ch", ja: "rec_ch", en: "rec_ch", ko: "rec_ko" };

  // ── Image ──────────────────────────────────────────────────────────────
  // img = { data: Uint8ClampedArray RGBA, width, height, canvas: OffscreenCanvas }
  async function decode(blob) {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return { data, width: canvas.width, height: canvas.height, canvas };
  }

  // Redimensionne une zone de l'image (interpolation du navigateur ≈ cv2.INTER_LINEAR)
  function resample(img, sx, sy, sw, sh, dw, dh) {
    const c = new OffscreenCanvas(dw, dh);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(img.canvas, sx, sy, sw, sh, 0, 0, dw, dh);
    return ctx.getImageData(0, 0, dw, dh).data;
  }

  // RGBA → tenseur NCHW float32 en BGR, (v/255 - 0.5) / 0.5
  function toTensor(rgba, w, h, padW = w) {
    const plane = h * padW;
    const out = new Float32Array(3 * plane);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, o = y * padW + x;
        out[o] = rgba[i + 2] / 127.5 - 1;           // B
        out[plane + o] = rgba[i + 1] / 127.5 - 1;   // G
        out[2 * plane + o] = rgba[i] / 127.5 - 1;   // R
      }
    }
    return out;
  }

  // ── Détection (DBNet) ──────────────────────────────────────────────────
  async function detect(img, y0, th) {
    const w = img.width;
    let ratio = Math.max(w, th) > DET_LIMIT ? DET_LIMIT / Math.max(w, th) : 1;
    const rw = Math.max(32, Math.round((w * ratio) / 32) * 32);
    const rh = Math.max(32, Math.round((th * ratio) / 32) * 32);
    const rgba = resample(img, 0, y0, w, th, rw, rh);
    const sess = await session("det");
    const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", toTensor(rgba, rw, rh), [1, 3, rh, rw]) });
    const prob = out[sess.outputNames[0]].data; // [1,1,rh,rw]

    // binarisation + dilatation 2x2
    const n = rw * rh;
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = prob[i] > 0.3 ? 1 : 0;
    const mask = new Uint8Array(n);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        mask[i] = bin[i] || (x > 0 && bin[i - 1]) || (y > 0 && bin[i - rw]) || (x > 0 && y > 0 && bin[i - rw - 1]) ? 1 : 0;
      }
    }

    // composantes connexes (8-connexité)
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    const boxes = [];
    for (let s = 0; s < n; s++) {
      if (!mask[s] || seen[s]) continue;
      let top = 0, minx = rw, miny = rh, maxx = 0, maxy = 0;
      stack[top++] = s; seen[s] = 1;
      while (top) {
        const p = stack[--top];
        const px = p % rw, py = (p - px) / rw;
        if (px < minx) minx = px; if (px > maxx) maxx = px;
        if (py < miny) miny = py; if (py > maxy) maxy = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= rh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= rw) continue;
            const q = ny * rw + nx;
            if (mask[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
          }
        }
      }
      const bw = maxx - minx, bh = maxy - miny;
      if (Math.min(bw, bh) < 3) continue;
      // score = moyenne de la probabilité dans la boîte
      let sum = 0;
      for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) sum += prob[y * rw + x];
      const score = sum / ((bw + 1) * (bh + 1));
      if (score < 0.5) continue;
      // unclip (ratio 1.6)
      const d = (bw * bh * 1.6) / (2 * (bw + bh));
      const ex0 = minx - d, ey0 = miny - d, ex1 = maxx + d, ey1 = maxy + d;
      if (Math.min(ex1 - ex0, ey1 - ey0) < 5) continue;
      const sx = w / rw, sy = th / rh;
      const bx0 = Math.max(0, Math.round(ex0 * sx)), by0 = Math.max(0, Math.round(ey0 * sy));
      const bx1 = Math.min(w, Math.round(ex1 * sx)), by1 = Math.min(th, Math.round(ey1 * sy));
      if (bx1 - bx0 <= 3 || by1 - by0 <= 3) continue;
      boxes.push([bx0, by0, bx1, by1]);
    }
    return boxes;
  }

  // ── Reconnaissance (CTC) ───────────────────────────────────────────────
  async function recognize(img, box, recName) {
    const [x0, y0, x1, y1] = box;
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 2 || ch < 2) return { text: "", score: 0 };
    const vertical = ch / cw >= 1.5; // colonne verticale → rotation 90° anti-horaire
    const srcW = vertical ? ch : cw, srcH = vertical ? cw : ch;
    const rw = Math.max(1, Math.ceil(REC_H * (srcW / srcH)));
    const padW = Math.max(320, rw);
    const c = new OffscreenCanvas(rw, REC_H);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (vertical) {
      const s = REC_H / cw;
      // (x, y) → (y, cw - x) puis mise à l'échelle
      ctx.setTransform(0, -s, (rw / ch), 0, 0, cw * s);
    } else {
      ctx.setTransform(rw / cw, 0, 0, REC_H / ch, 0, 0);
    }
    ctx.drawImage(img.canvas, x0, y0, cw, ch, 0, 0, cw, ch);
    const rgba = ctx.getImageData(0, 0, rw, REC_H).data;

    const sess = await session(recName);
    const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", toTensor(rgba, rw, REC_H, padW), [1, 3, REC_H, padW]) });
    const t = out[sess.outputNames[0]];
    const [, T, C] = t.dims;
    const chars = await dict(recName, C);
    let text = "", probSum = 0, kept = 0, prev = -1;
    for (let i = 0; i < T; i++) {
      let best = 0, bp = -Infinity;
      const off = i * C;
      for (let k = 0; k < C; k++) { const v = t.data[off + k]; if (v > bp) { bp = v; best = k; } }
      if (best !== 0 && best !== prev) { text += chars[best] ?? ""; probSum += bp; kept++; }
      prev = best;
    }
    return { text: text.trim(), score: kept ? probSum / kept : 0 };
  }

  // ── Lecture complète (tranches) ────────────────────────────────────────
  function* tiles(h) {
    if (h <= TILE_H) { yield [0, h]; return; }
    let y = 0;
    while (true) {
      const y1 = Math.min(y + TILE_H, h);
      yield [y, y1];
      if (y1 >= h) return;
      y = y1 - OVERLAP;
    }
  }

  function blankTile(img, y0, y1) {
    // écart-type sur un échantillon 1 pixel / 8
    const { data, width } = img;
    let n = 0, s = 0, s2 = 0;
    for (let y = y0; y < y1; y += 8) {
      for (let x = 0; x < width; x += 8) {
        const i = (y * width + x) * 4;
        const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
        s += v; s2 += v * v; n++;
      }
    }
    const m = s / n;
    return Math.sqrt(Math.max(0, s2 / n - m * m)) < 4;
  }

  const MEANINGFUL = /[\p{L}\p{N}]/u;

  function iou(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    if (!inter) return 0;
    const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
    return inter / Math.min(area(a), area(b));
  }

  async function readLines(img, lang) {
    const recName = REC_MODEL[lang] || "rec_ch";
    const lines = [];
    for (const [y0, y1] of tiles(img.height)) {
      if (blankTile(img, y0, y1)) continue;
      const first = y0 === 0, last = y1 >= img.height;
      const boxes = await detect(img, y0, y1 - y0);
      for (const [bx0, by0, bx1, by1] of boxes) {
        // lignes coupées par le bord d'une tranche: une autre tranche les verra entières
        if ((!first && by0 <= 3) || (!last && by1 >= y1 - y0 - 3)) continue;
        const box = [bx0, by0 + y0, bx1, by1 + y0];
        if (lines.some((l) => iou(box, l.box) > 0.4)) continue;
        const { text, score } = await recognize(img, box, recName);
        lines.push({ box, text, score });
      }
    }
    return lines.filter((l) => l.score >= MIN_SCORE && l.text && MEANINGFUL.test(l.text)
      && !(l.text.length === 1 && /^[\x00-\x7f]$/.test(l.text)));
  }

  // ── Regroupement lignes → bulles ──────────────────────────────────────
  const isVertical = (l) => (l.box[3] - l.box[1]) > 1.5 * (l.box[2] - l.box[0]) && l.text.length >= 2;

  function sameBlock(a, b) {
    const va = isVertical(a), vb = isVertical(b);
    if (va !== vb) return false;
    let A = a.box, B = b.box;
    if (va) { A = [A[1], A[0], A[3], A[2]]; B = [B[1], B[0], B[3], B[2]]; }
    const ha = A[3] - A[1], hb = B[3] - B[1];
    if (Math.max(ha, hb) > 1.7 * Math.min(ha, hb)) return false;
    const lh = (ha + hb) / 2;
    const vgap = Math.max(B[1] - A[3], A[1] - B[3]);
    if (vgap > 0.9 * lh) return false;
    if (Math.min(A[2], B[2]) - Math.max(A[0], B[0]) > 0) return true;
    if (va) return false;
    const acx = (A[0] + A[2]) / 2, bcx = (B[0] + B[2]) / 2;
    return Math.abs(acx - bcx) < 1.5 * lh && vgap > -0.5 * lh;
  }

  function groupBlocks(lines, rtl) {
    const parent = lines.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < lines.length; i++)
      for (let j = i + 1; j < lines.length; j++)
        if (sameBlock(lines[i], lines[j])) parent[find(i)] = find(j);
    const groups = new Map();
    lines.forEach((l, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); });
    const blocks = [...groups.values()].map((g) =>
      isVertical(g[0]) ? g.sort((a, b) => b.box[2] - a.box[2]) : g.sort((a, b) => a.box[1] - b.box[1]));
    // ordre de lecture: rangées haut → bas, puis gauche → droite (droite → gauche si rtl)
    const bbox = (g) => [Math.min(...g.map((l) => l.box[0])), Math.min(...g.map((l) => l.box[1])),
      Math.max(...g.map((l) => l.box[2])), Math.max(...g.map((l) => l.box[3]))];
    const items = blocks.map((g) => ({ b: bbox(g), g })).sort((p, q) => p.b[1] - q.b[1]);
    const rows = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row) {
        const ry0 = Math.min(...row.map((r) => r.b[1])), ry1 = Math.max(...row.map((r) => r.b[3]));
        const h = it.b[3] - it.b[1];
        if (Math.min(it.b[3], ry1) - Math.max(it.b[1], ry0) > 0.5 * Math.min(h, ry1 - ry0)) { row.push(it); continue; }
      }
      rows.push([it]);
    }
    return rows.flatMap((row) => row.sort((p, q) => (rtl ? q.b[2] - p.b[2] : p.b[0] - q.b[0])).map((r) => r.g));
  }

  const CJK = /[　-〿぀-ヿ㐀-鿿＀-￯]/;
  function joinLines(texts) {
    let out = "";
    for (const t of texts) {
      if (out && !(CJK.test(out[out.length - 1]) && CJK.test(t[0]))) out += " ";
      out += t;
    }
    return out;
  }

  // ── Couleurs + effacement du texte ────────────────────────────────────
  function median(values) {
    if (!values.length) return 0;
    const a = Float32Array.from(values).sort();
    return a[a.length >> 1];
  }

  function ringColor(img, x0, y0, x1, y1, pad) {
    const { data, width, height } = img;
    const X0 = Math.max(0, x0 - pad), Y0 = Math.max(0, y0 - pad);
    const X1 = Math.min(width, x1 + pad), Y1 = Math.min(height, y1 + pad);
    const r = [], g = [], b = [];
    const add = (x, y) => { const i = (y * width + x) * 4; r.push(data[i]); g.push(data[i + 1]); b.push(data[i + 2]); };
    for (let x = X0; x < X1; x++) for (const y of [Y0, Y0 + 1, Y1 - 2, Y1 - 1]) if (y >= Y0 && y < Y1) add(x, y);
    for (let y = Y0; y < Y1; y++) for (const x of [X0, X0 + 1, X1 - 2, X1 - 1]) if (x >= X0 && x < X1) add(x, y);
    return [median(r), median(g), median(b)];
  }

  const hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

  // Remplissage des pixels masqués depuis les bords (couche par couche, moyenne des voisins connus)
  function inpaint(rgba, w, h, mask) {
    const known = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) known[i] = mask[i] ? 0 : 1;
    let front = [];
    for (let i = 0; i < w * h; i++) if (!known[i]) front.push(i);
    let guard = 0;
    while (front.length && guard++ < 400) {
      const next = [], fill = [];
      for (const p of front) {
        const x = p % w, y = (p - x) / w;
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const q = ny * w + nx;
            if (!known[q]) continue;
            const wt = 1 / (dx * dx + dy * dy);
            r += rgba[q * 4] * wt; g += rgba[q * 4 + 1] * wt; b += rgba[q * 4 + 2] * wt; wsum += wt;
          }
        }
        if (wsum) fill.push([p, r / wsum, g / wsum, b / wsum]); else next.push(p);
      }
      if (!fill.length) break;
      for (const [p, r, g, b] of fill) { rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; known[p] = 1; }
      front = next;
    }
  }

  function cleanBlock(img, lineBoxes) {
    const { data, width, height } = img;
    const ctxPad = 12;
    const X0 = Math.max(0, Math.min(...lineBoxes.map((b) => b[0])) - ctxPad);
    const Y0 = Math.max(0, Math.min(...lineBoxes.map((b) => b[1])) - ctxPad);
    const X1 = Math.min(width, Math.max(...lineBoxes.map((b) => b[2])) + ctxPad);
    const Y1 = Math.min(height, Math.max(...lineBoxes.map((b) => b[3])) + ctxPad);
    const pw = X1 - X0, ph = Y1 - Y0;
    const crop = new Uint8ClampedArray(pw * ph * 4);
    for (let y = 0; y < ph; y++) crop.set(data.subarray(((Y0 + y) * width + X0) * 4, ((Y0 + y) * width + X1) * 4), y * pw * 4);

    const mask = new Uint8Array(pw * ph);
    const bgs = [], fgs = [];
    for (const [x0, y0, x1, y1] of lineBoxes) {
      const bg = ringColor(img, x0, y0, x1, y1, 3);
      bgs.push(bg);
      const a0 = Math.max(0, x0 - 3 - X0), b0 = Math.max(0, y0 - 3 - Y0);
      const a1 = Math.min(pw, x1 + 3 - X0), b1 = Math.min(ph, y1 + 3 - Y0);
      const dists = [];
      for (let y = b0; y < b1; y++) {
        for (let x = a0; x < a1; x++) {
          const i = (y * pw + x) * 4;
          const d = Math.abs(crop[i] - bg[0]) + Math.abs(crop[i + 1] - bg[1]) + Math.abs(crop[i + 2] - bg[2]);
          dists.push(d);
          if (d > 35) mask[y * pw + x] = 1;
        }
      }
      // couleur du texte = médiane des 15 % de pixels les plus éloignés du fond
      const thr = median(dists.slice().sort((p, q) => p - q).slice(Math.floor(dists.length * 0.85)));
      const fr = [], fgc = [], fb = [];
      for (let y = b0; y < b1; y++) for (let x = a0; x < a1; x++) {
        const i = (y * pw + x) * 4;
        const d = Math.abs(crop[i] - bg[0]) + Math.abs(crop[i + 1] - bg[1]) + Math.abs(crop[i + 2] - bg[2]);
        if (d >= thr && d > 0) { fr.push(crop[i]); fgc.push(crop[i + 1]); fb.push(crop[i + 2]); }
      }
      if (fr.length) fgs.push([median(fr), median(fgc), median(fb)]);
    }
    // dilatation 7x7 (≈ 3 passes de 3x3)
    const dil = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      if (!mask[y * pw + x]) continue;
      for (let dy = -3; dy <= 3; dy++) { const ny = y + dy; if (ny < 0 || ny >= ph) continue;
        for (let dx = -3; dx <= 3; dx++) { const nx = x + dx; if (nx >= 0 && nx < pw) dil[ny * pw + nx] = 1; } }
    }
    inpaint(crop, pw, ph, dil);

    const bg = [0, 1, 2].map((k) => median(bgs.map((c) => c[k])));
    let fg = fgs.length ? [0, 1, 2].map((k) => median(fgs.map((c) => c[k]))) : bg.map((v) => 255 - v);
    if (Math.abs(fg[0] - bg[0]) + Math.abs(fg[1] - bg[1]) + Math.abs(fg[2] - bg[2]) < 150) {
      fg = (bg[0] + bg[1] + bg[2]) / 3 > 127 ? [0, 0, 0] : [255, 255, 255];
    }
    return { patchBox: [X0, Y0, X1, Y1], clean: crop, bg: hex(bg), fg: hex(fg) };
  }

  // Intérieur de la bulle (remplissage depuis le centre) → zone utilisable pour le texte
  function bubbleBox(img, clean, patchBox, box) {
    const { data, width: W, height: H } = img;
    const [x0, y0, x1, y1] = box;
    const m = Math.floor(Math.max(x1 - x0, y1 - y0) * 0.8) + 24;
    const WX0 = Math.max(0, x0 - m), WY0 = Math.max(0, y0 - m), WX1 = Math.min(W, x1 + m), WY1 = Math.min(H, y1 + m);
    const ww = WX1 - WX0, wh = WY1 - WY0;
    const [px0, py0, px1, py1] = patchBox, pw = px1 - px0;
    const px = (x, y) => { // pixel de la fenêtre, avec le patch nettoyé par-dessus
      if (x >= px0 && x < px1 && y >= py0 && y < py1) { const i = ((y - py0) * pw + (x - px0)) * 4; return [clean[i], clean[i + 1], clean[i + 2]]; }
      const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]];
    };
    const sx = (x0 + x1) >> 1, sy = (y0 + y1) >> 1;
    const seed = px(sx, sy), tol = 14;
    const inside = new Uint8Array(ww * wh);
    const stack = [sx - WX0 + (sy - WY0) * ww];
    inside[stack[0]] = 1;
    let minx = ww, miny = wh, maxx = 0, maxy = 0, count = 0, touches = false;
    while (stack.length) {
      const p = stack.pop();
      const x = p % ww, y = (p - x) / ww;
      count++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if ((x === 0 && WX0 > 0) || (x === ww - 1 && WX1 < W) || (y === 0 && WY0 > 0) || (y === wh - 1 && WY1 < H)) touches = true;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
        const q = ny * ww + nx;
        if (inside[q]) continue;
        const c = px(nx + WX0, ny + WY0);
        if (Math.abs(c[0] - seed[0]) <= tol && Math.abs(c[1] - seed[1]) <= tol && Math.abs(c[2] - seed[2]) <= tol) {
          inside[q] = 1; stack.push(q);
        }
      }
    }
    if (touches) return null; // pas une bulle fermée
    const bx0 = minx + WX0, by0 = miny + WY0, bx1 = maxx + WX0, by1 = maxy + WY0;
    if (bx1 - bx0 < x1 - x0 || by1 - by0 < y1 - y0) return null;
    const fill = count / ((bx1 - bx0 + 1) * (by1 - by0 + 1));
    if (fill < 0.45) return null; // forme trop irrégulière: décor, pas une bulle
    const k = fill > 0.93 ? 0.88 : 0.72;
    const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
    const hw = ((bx1 - bx0) * k) / 2 - 3, hh = ((by1 - by0) * k) / 2 - 3;
    return [Math.floor(Math.min(cx - hw, x0)), Math.floor(Math.min(cy - hh, y0)), Math.ceil(Math.max(cx + hw, x1)), Math.ceil(Math.max(cy + hh, y1))];
  }

  async function pngB64(rgba, w, h) {
    const c = new OffscreenCanvas(w, h);
    c.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ── API ────────────────────────────────────────────────────────────────
  async function analyze(blob, lang = "auto") {
    const t0 = performance.now();
    const img = await decode(blob);
    const lines = await readLines(img, lang);
    const blocks = [];
    for (const group of groupBlocks(lines, lang === "ja")) {
      const boxes = group.map((l) => l.box);
      const box = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
      const { patchBox, clean, bg, fg } = cleanBlock(img, boxes);
      blocks.push({
        box,
        fit_box: bubbleBox(img, clean, patchBox, box),
        lines: boxes,
        text: joinLines(group.map((l) => l.text)),
        bg, fg,
        patch_box: patchBox,
        patch: await pngB64(clean, patchBox[2] - patchBox[0], patchBox[3] - patchBox[1]),
      });
    }
    // une zone de bulle ne doit jamais empiéter sur le texte d'une autre bulle
    const overlaps = (a, b) => a[0] < b[2] + 2 && b[0] < a[2] + 2 && a[1] < b[3] + 2 && b[1] < a[3] + 2;
    for (const b of blocks) {
      if (b.fit_box && blocks.some((o) => o !== b && overlaps(b.fit_box, o.box))) b.fit_box = null;
    }
    return { width: img.width, height: img.height, blocks, ms: Math.round(performance.now() - t0) };
  }

  async function warmup() {
    await Promise.all([session("det"), session("rec_ch")]);
  }

  // une seule inférence à la fois (ONNX Runtime Web ne supporte pas les run() concurrents)
  let chain = Promise.resolve();
  const serial = (fn) => (...a) => { const p = chain.then(() => fn(...a)); chain = p.catch(() => {}); return p; };

  self.KomaOCR = {
    analyze: serial(analyze),
    warmup: serial(warmup),
    readLines: serial(async (blob, lang) => readLines(await decode(blob), lang)),
  };
})();
