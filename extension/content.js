// KomaTranslator Live — script injecté dans les pages
(() => {
  const MIN_W = 250, MIN_H = 200;           // ignore icônes, avatars, pubs...
  const IS_FIREFOX = navigator.userAgent.includes("Firefox");
  const FONT = "KomaFont, 'Comic Sans MS', 'Comic Neue', 'Segoe UI', sans-serif";

  // Le site "actif" est celui de l'onglet (même dans une iframe de lecteur)
  const anc = location.ancestorOrigins;
  const HOST = anc && anc.length ? new URL(anc[anc.length - 1]).hostname : location.hostname;

  let enabled = false;
  const state = new Map(); // img → {origSrc, origSrcset, url, translatedUrl, busy}

  // ── Police BD (optionnelle: extension/fonts/font.otf) ──
  (async () => {
    try {
      const f = new FontFace("KomaFont", `url(${chrome.runtime.getURL("fonts/font.otf")})`);
      document.fonts.add(await f.load());
    } catch { /* pas de police fournie → Comic Sans */ }
  })();

  // ── Détection des images à traiter ──
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { io.unobserve(e.target); processImg(e.target); }
    }
  }, { rootMargin: "1500px 0px" });

  function watch(img) {
    if (!enabled) return;
    const st = state.get(img);
    if (st && (st.busy || (st.translatedUrl && img.src === st.translatedUrl))) return;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener("load", () => watch(img), { once: true });
      return;
    }
    if (img.naturalWidth < MIN_W || img.naturalHeight < MIN_H) return;
    io.observe(img);
  }

  function scan(root) {
    if (root.tagName === "IMG") watch(root);
    root.querySelectorAll?.("img").forEach(watch);
  }

  const mo = new MutationObserver((muts) => {
    if (!enabled) return;
    for (const m of muts) {
      if (m.type === "attributes") watch(m.target);
      else m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n));
    }
  });

  // ── Traitement d'une image ──
  async function processImg(img) {
    const url = img.currentSrc || img.src;
    if (!url) return;
    let st = state.get(img);
    if (st && st.url === url) return; // déjà fait (ou sans texte)
    if (st?.translatedUrl) URL.revokeObjectURL(st.translatedUrl);
    st = { origSrc: img.getAttribute("src"), origSrcset: img.getAttribute("srcset"), url, busy: true };
    state.set(img, st);
    img.classList.add("kt-busy");
    try {
      const msg = { type: "translate", url, pageUrl: location.href };
      if (url.startsWith("blob:") || url.startsWith("data:")) {
        const blob = await (await fetch(url)).blob();
        msg.bytes = await blobToB64(blob);
        msg.mime = blob.type;
      }
      const res = await chrome.runtime.sendMessage(msg);
      if (!res?.ok) throw new Error(res?.error || "pas de réponse");
      if (!enabled || (img.currentSrc || img.src) !== url) return; // l'image a changé entre-temps
      if (!res.data.blocks.length) return;
      const out = await render(res.image, res.data);
      st.translatedUrl = out;
      img.removeAttribute("srcset");
      const pic = img.parentElement?.tagName === "PICTURE" ? img.parentElement : null;
      pic?.querySelectorAll("source").forEach((s) => {
        s.dataset.ktSrcset = s.srcset;
        s.removeAttribute("srcset");
      });
      img.src = out;
    } catch (e) {
      console.warn("[KomaTranslator]", url, e);
      img.title = "KomaTranslator: " + e.message;
    } finally {
      st.busy = false;
      img.classList.remove("kt-busy");
    }
  }

  function restoreAll() {
    for (const [img, st] of state) {
      if (st.translatedUrl && img.src === st.translatedUrl) {
        if (st.origSrcset) img.setAttribute("srcset", st.origSrcset);
        img.parentElement?.querySelectorAll("source[data-kt-srcset]").forEach((s) => {
          s.srcset = s.dataset.ktSrcset;
          delete s.dataset.ktSrcset;
        });
        img.src = st.origSrc || st.url;
        URL.revokeObjectURL(st.translatedUrl);
      }
      img.classList.remove("kt-busy");
    }
    state.clear();
  }

  // ── Rendu: image d'origine + zones nettoyées + texte traduit ──
  async function render(imageDataUrl, data) {
    const base = await createImageBitmap(dataUrlToBlob(imageDataUrl));
    const c = document.createElement("canvas");
    c.width = base.width;
    c.height = base.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(base, 0, 0);
    for (const b of data.blocks) {
      const patch = await createImageBitmap(dataUrlToBlob("data:image/png;base64," + b.patch));
      ctx.drawImage(patch, b.patch_box[0], b.patch_box[1]);
    }
    for (const b of data.blocks) drawText(ctx, b);
    // Firefox: un blob: créé par le script de contenu n'est pas chargeable par la page → data URL
    if (IS_FIREFOX) return c.toDataURL("image/jpeg", 0.93);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.93));
    return URL.createObjectURL(blob);
  }

  function drawText(ctx, b) {
    const text = (b.translation || "").trim();
    if (!text) return;
    let [x0, y0, x1, y1] = b.box;
    let w = x1 - x0, h = y1 - y0;
    // le français est plus long que le chinois: on s'autorise un peu plus de largeur
    const extra = Math.min(w * 0.05, 8);
    if (w < h * 0.6) { x0 -= (h * 0.6 - w) / 2; w = h * 0.6; } // texte vertical (manga)
    x0 -= extra; w += 2 * extra;
    y0 -= 4; h += 8;
    const lineH0 = b.lines.reduce((s, l) => s + (l[3] - l[1]), 0) / b.lines.length;
    const maxSize = Math.max(12, Math.min(72, lineH0 * 1.15));

    let lo = 8, hi = Math.floor(maxSize), best = null;
    while (lo <= hi) {
      const size = (lo + hi) >> 1;
      const lines = wrap(ctx, text, size, w);
      if (lines && lines.length * size * 1.2 <= h) { best = { size, lines }; lo = size + 1; }
      else hi = size - 1;
    }
    if (!best) best = { size: 8, lines: wrap(ctx, text, 8, w, true) };

    const { size, lines } = best;
    const lh = size * 1.2;
    ctx.font = `bold ${size}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeStyle = b.bg;
    ctx.fillStyle = b.fg;
    const cx = x0 + w / 2;
    let y = y0 + h / 2 - (lines.length * lh) / 2 + lh / 2;
    for (const line of lines) {
      ctx.strokeText(line, cx, y);
      ctx.fillText(line, cx, y);
      y += lh;
    }
  }

  // Découpe en lignes; null si un mot ne rentre pas (sauf force=true)
  function wrap(ctx, text, size, maxW, force = false) {
    ctx.font = `bold ${size}px ${FONT}`;
    const words = text.split(/\s+/);
    const lines = [];
    let cur = "";
    for (const word of words) {
      const t = cur ? cur + " " + word : word;
      if (ctx.measureText(t).width <= maxW) { cur = t; continue; }
      if (cur) lines.push(cur);
      if (ctx.measureText(word).width > maxW) {
        if (!force) return null;
        let part = "";
        for (const ch of word) {
          if (ctx.measureText(part + ch).width > maxW && part) { lines.push(part); part = ""; }
          part += ch;
        }
        cur = part;
      } else cur = word;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // ── Utilitaires ──
  function dataUrlToBlob(u) {
    const [head, b64] = u.split(",");
    const mime = head.slice(5).split(";")[0] || "image/png";
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  function blobToB64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  // ── Activation / désactivation ──
  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
      scan(document);
    } else {
      mo.disconnect();
      io.disconnect();
      restoreAll();
    }
  }

  chrome.storage.sync.get(["sites"]).then(({ sites = {} }) => setEnabled(!!sites[HOST]));
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.sites) setEnabled(!!(ch.sites.newValue || {})[HOST]);
    if ((ch.src || ch.tgt) && enabled) { setEnabled(false); setEnabled(true); } // langue changée → retraduire
  });
})();
