// KomaTranslator — script injecté dans les pages
// Rôle: repérer les <img> de lecture, les envoyer au background (message "translate"),
// puis remplacer leur source par l'image redessinée (zones effacées + texte traduit).
// Il ne fait ni OCR ni traduction: tout se passe dans background.js.
(() => {
  const MIN_W = 250, MIN_H = 200;           // ignore icônes, avatars, pubs...
  const IS_FIREFOX = navigator.userAgent.includes("Firefox");
  const BASE_FONT = "KomaFont, 'Comic Sans MS', 'Comic Neue', 'Segoe UI', sans-serif";
  let FONT = BASE_FONT; // police choisie dans les options (storage.sync « font ») en tête de la pile
  let CAPS = false;     // option « tout en majuscules » (storage.sync « caps »): lettrage BD

  // Le site "actif" est celui de l'onglet (même dans une iframe de lecteur)
  const anc = location.ancestorOrigins;
  const HOST = anc && anc.length ? new URL(anc[anc.length - 1]).hostname : location.hostname;

  let enabled = false;
  let ECO = false;          // mode économie (storage.sync « eco »): seulement ce qui est à l'écran
  let paused = false;       // pause demandée depuis le menu: plus aucune image n'est envoyée
  let originalView = false; // « voir l'original »: les images traduites sont masquées, sans rien perdre
  const state = new Map(); // img → {origSrc, origSrcset, url, translatedUrl, res, busy}
  const tracked = new Set();   // images assez grandes, sous surveillance
  const failed = new Map();    // img → message, pour les échecs définitifs
  const freshNext = new Set(); // images à retraduire sans passer par le cache (Alt+Maj+clic)

  /** Remet l'image d'origine à l'écran (srcset et <source> compris), en gardant la traduction pour y revenir. */
  function showOriginal(img, st) {
    if (st.origSrcset) img.setAttribute("srcset", st.origSrcset);
    img.parentElement?.querySelectorAll("source[data-kt-srcset]").forEach((s) => { s.srcset = s.dataset.ktSrcset; });
    img.src = st.origSrc || st.url;
  }
  /** Affiche l'image traduite (les srcset d'origine sont mis de côté dans data-kt-srcset). */
  function showTranslated(img, st) {
    img.removeAttribute("srcset");
    if (img.parentElement?.tagName === "PICTURE") {
      img.parentElement.querySelectorAll("source").forEach((s) => {
        if (s.dataset.ktSrcset === undefined) s.dataset.ktSrcset = s.srcset;
        s.removeAttribute("srcset");
      });
    }
    img.src = st.translatedUrl;
  }

  /** Police des options: un nom de police installée sur le système, placé avant la pile par défaut (vide = défaut). */
  function applyFont(name) {
    const n = String(name || "").replace(/["'\\;{}]/g, "").trim();
    FONT = n ? `"${n}", ${BASE_FONT}` : BASE_FONT;
  }

  /** Redessine toutes les images déjà traduites avec la police courante, sans OCR ni traduction (résultats en mémoire). */
  let rerenderId = 0;
  async function rerenderAll() {
    const id = ++rerenderId; // un nouveau changement de police interrompt le précédent
    for (const [img, st] of state) {
      if (id !== rerenderId) return;
      if (!st.res || !st.translatedUrl) continue;
      const old = st.translatedUrl, showing = img.src === old; // en « voir l'original »: on met à jour sans afficher
      const out = await render(st.res.image, st.res.data);
      if (id !== rerenderId || st.translatedUrl !== old) { URL.revokeObjectURL(out); continue; }
      URL.revokeObjectURL(old);
      st.translatedUrl = out;
      if (showing) img.src = out;
    }
  }

  // ── Police BD: fonts/font.otf si présente (police perso), sinon Comic Neue (OFL, embarquée) ──
  (async () => {
    for (const file of ["fonts/font.otf", "fonts/ComicNeue-Bold.ttf"]) {
      try {
        const f = new FontFace("KomaFont", `url(${chrome.runtime.getURL(file)})`);
        document.fonts.add(await f.load());
        return;
      } catch { /* suivante */ }
    }
  })();

  // ── Détection des images à traiter ──
  // "near" = images proches de l'écran; on traite d'abord celle qui est à l'écran,
  // puis celles juste en dessous; celles qu'on a dépassées passent en dernier.
  const near = new Set();
  const retries = new WeakMap();
  const MAX_INFLIGHT = 2;
  let inflight = 0;
  let generation = 0; // augmente à chaque (ré)activation: les résultats des travaux plus anciens sont ignorés

  /** Zone autour de l'écran où l'on prépare les images: 4000 px normalement, 700 px en mode économie (moins de jetons gaspillés). */
  const makeIo = () => new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? near.add(e.target) : near.delete(e.target);
    pump();
  }, { rootMargin: ECO ? "700px 0px" : "4000px 0px" });
  let io = makeIo();
  /** Reprend la surveillance de toutes les images (après une pause, un changement de mode...). */
  function rewatch() {
    io.disconnect();
    near.clear();
    scan(document);
  }

  /** Plus petit = plus urgent: 0 si visible, sinon distance sous l'écran (ordre de lecture), les images dépassées en dernier. */
  function priority(img) {
    const r = img.getBoundingClientRect();
    if (r.bottom >= 0 && r.top <= innerHeight) return 0;   // visible
    if (r.top > innerHeight) return r.top - innerHeight;    // plus bas: dans l'ordre de lecture
    return 3 * -r.bottom;                                    // déjà dépassée
  }

  /** Lance le traitement des images proches, la plus prioritaire d'abord, MAX_INFLIGHT à la fois. */
  function pump() {
    while (enabled && !paused && !(ECO && document.hidden) && inflight < MAX_INFLIGHT && near.size) {
      let best = null, bestP = Infinity;
      for (const img of near) {
        if (!img.isConnected) { near.delete(img); continue; }
        const p = priority(img);
        if (p < bestP) { best = img; bestP = p; }
      }
      if (!best) return;
      near.delete(best);
      inflight++;
      const g = generation;
      processImg(best).finally(() => { if (g === generation) inflight--; pump(); }); // périmé: sa place est déjà libérée
    }
  }
  addEventListener("scroll", () => { if (inflight < MAX_INFLIGHT) pump(); }, { passive: true });

  /** Met une image sous surveillance si elle est assez grande (attend son chargement sinon). */
  function watch(img) {
    if (!enabled || originalView) return;
    const st = state.get(img);
    if (st && (st.busy || (st.translatedUrl && img.src === st.translatedUrl))) return;
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener("load", () => watch(img), { once: true });
      return;
    }
    if (img.naturalWidth < MIN_W || img.naturalHeight < MIN_H) return;
    tracked.add(img);
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
  /** Envoie l'image au background, dessine le résultat et remplace la source de l'<img> (avec reprises en cas d'échec). */
  async function processImg(img) {
    const url = img.currentSrc || img.src;
    if (!url) return;
    let st = state.get(img);
    if (st && st.url === url) return; // déjà fait (ou sans texte)
    if (st?.translatedUrl) URL.revokeObjectURL(st.translatedUrl);
    const gen = generation; // un changement de langue / une réactivation rend ce travail périmé
    st = { origSrc: img.getAttribute("src"), origSrcset: img.getAttribute("srcset"), url, busy: true };
    state.set(img, st);
    img.classList.add("kt-busy");
    try {
      const msg = { type: "translate", url, pageUrl: location.href, host: HOST, pos: Math.round(img.getBoundingClientRect().top + scrollY) };
      if (freshNext.delete(img)) msg.fresh = true; // retraduction demandée: pas de cache
      if (url.startsWith("blob:") || url.startsWith("data:")) {
        const blob = await (await fetch(url)).blob();
        msg.bytes = await blobToB64(blob);
        msg.mime = blob.type;
      }
      const res = await chrome.runtime.sendMessage(msg);
      if (gen !== generation) return; // résultat d'avant le changement (ex. ancienne langue): ignoré, l'image est déjà relancée
      if (res?.cancelled) { state.delete(img); return; } // pause: l'image sera reprise plus tard
      if (!res?.ok) throw new Error(res?.error || "pas de réponse");
      failed.delete(img);
      if (!enabled || (img.currentSrc || img.src) !== url) return; // l'image a changé entre-temps
      io.unobserve(img);
      if (!res.data.blocks.length) return;
      const out = await render(res.image, res.data);
      if (gen !== generation) { URL.revokeObjectURL(out); return; }
      st.translatedUrl = out;
      st.res = res; // pour l'infobulle et les corrections
      attachInteractions(img);
      if (!originalView) showTranslated(img, st);
    } catch (e) {
      if (gen !== generation) return;
      console.warn("[KomaTranslator]", url, e);
      const n = retries.get(img) || 0;
      if (n < 2 && enabled) { // requête perdue / serveur occupé: on réessaie (le serveur garde le résultat en cache)
        retries.set(img, n + 1);
        state.delete(img);
        setTimeout(() => { near.add(img); pump(); }, 1500 * (n + 1));
      } else { img.title = "KomaTranslator: " + e.message; failed.set(img, e.message); }
    } finally {
      st.busy = false;
      if (gen === generation) img.classList.remove("kt-busy"); // sinon c'est le nouveau travail qui gère l'image
    }
  }

  // ── Survol: texte d'origine · Alt+clic: corriger la traduction ──
  /** Bulle sous le curseur (coordonnées écran → coordonnées de l'image d'origine, marge de 10 px), ou null. */
  function blockAt(img, ev) {
    const st = state.get(img);
    if (!st?.res || img.src !== st.translatedUrl) return null;
    const r = img.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (st.res.data.width / r.width);
    const y = (ev.clientY - r.top) * (st.res.data.height / r.height);
    return st.res.data.blocks.find((b) => {
      const [x0, y0, x1, y1] = b.fit_box || b.box;
      return x >= x0 - 10 && x <= x1 + 10 && y >= y0 - 10 && y <= y1 + 10;
    }) || null;
  }

  function attachInteractions(img) {
    if (img.dataset.ktHooks) return;
    img.dataset.ktHooks = "1";
    img.addEventListener("mousemove", (ev) => {
      if (!enabled) return;
      const b = blockAt(img, ev);
      const t = b ? `${b.text}\n→ ${b.translation}\n(Alt+clic : corriger · Alt+Maj+clic : retraduire l'image)` : "";
      if (img.title !== t) img.title = t;
      img.style.cursor = b && ev.altKey ? "text" : "";
    });
    img.addEventListener("click", async (ev) => {
      if (!enabled || !ev.altKey) return;
      if (ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); retranslateImg(img); return; }
      const b = blockAt(img, ev);
      if (!b) return;
      ev.preventDefault();
      ev.stopPropagation();
      const fixed = prompt(`Original :\n${b.text}\n\nTraduction corrigée :`, b.translation);
      if (fixed == null || fixed.trim() === b.translation) return;
      b.translation = fixed.trim();
      const st = state.get(img);
      const out = await render(st.res.image, st.res.data);
      URL.revokeObjectURL(st.translatedUrl);
      st.translatedUrl = out;
      img.src = out;
      chrome.runtime.sendMessage({ type: "correct", page: location.href, text: b.text, translation: b.translation });
    }, true);
  }

  /** Retraduit une seule image sans utiliser le cache (Alt+Maj+clic). */
  function retranslateImg(img) {
    const st = state.get(img);
    if (!st) return;
    if (st.translatedUrl) { showOriginal(img, st); URL.revokeObjectURL(st.translatedUrl); }
    state.delete(img);
    failed.delete(img);
    freshNext.add(img);
    img.addEventListener("load", () => { near.add(img); pump(); }, { once: true });
  }

  // ── Statistiques envoyées au menu (via le background) ──
  const shortUrl = (u) => decodeURIComponent(String(u).split("?")[0].split("/").pop() || u).slice(0, 40);
  function stats() {
    let done = 0, empty = 0, busy = 0;
    for (const [img, st] of state) {
      if (!img.isConnected) continue;
      if (st.busy) busy++;
      else if (st.translatedUrl) done++;
      else if (!failed.has(img)) empty++;
    }
    const bad = [...failed].filter(([img]) => img.isConnected);
    return {
      tracked: [...tracked].filter((i) => i.isConnected).length, done, empty, busy, queued: near.size, failed: bad.length,
      errors: bad.slice(0, 5).map(([img, error]) => ({ url: shortUrl(img.currentSrc || img.src), error })),
      paused, original: originalView, enabled,
    };
  }
  let lastStats = JSON.stringify(stats()), statsTimer = null;
  function sendStats() {
    const s = JSON.stringify(stats());
    if (s === lastStats) return;
    lastStats = s;
    chrome.runtime.sendMessage({ type: "pageStats", stats: JSON.parse(s) }).catch(() => {});
  }

  /** Pause: plus aucune image n'est envoyée et celles qui attendent dans la file sont retirées. */
  function setPaused(on) {
    if (on === paused) return;
    paused = on;
    if (on) { near.clear(); chrome.runtime.sendMessage({ type: "cancelQueue" }).catch(() => {}); }
    else { chrome.runtime.sendMessage({ type: "resumeQueue" }).catch(() => {}); rewatch(); }
    sendStats();
  }

  /** « Voir l'original »: bascule entre les images d'origine et les images traduites, sans retraduire. */
  function setOriginal(on) {
    if (on === originalView) return;
    originalView = on;
    for (const [img, st] of state) {
      if (!st.translatedUrl) continue;
      if (on) showOriginal(img, st); else showTranslated(img, st);
    }
    if (!on) rewatch();
    sendStats();
  }

  /** Mode économie: change la zone de préparation et reprend la surveillance. */
  function setEco(on) {
    if (on === ECO) return;
    ECO = on;
    io.disconnect();
    io = makeIo();
    if (enabled) { near.clear(); scan(document); }
  }

  /** Remet toutes les images dans leur état d'origine (désactivation du site). */
  function restoreAll() {
    for (const [img, st] of state) {
      if (st.translatedUrl) URL.revokeObjectURL(st.translatedUrl);
      if (st.translatedUrl && img.src === st.translatedUrl) {
        if (st.origSrcset) img.setAttribute("srcset", st.origSrcset);
        img.parentElement?.querySelectorAll("source[data-kt-srcset]").forEach((s) => {
          s.srcset = s.dataset.ktSrcset;
          delete s.dataset.ktSrcset;
        });
        img.src = st.origSrc || st.url;
      }
      img.classList.remove("kt-busy");
    }
    state.clear();
    tracked.clear();
    failed.clear();
  }

  // ── Rendu: image d'origine + zones nettoyées + texte traduit ──
  /** Dessine l'image d'origine, colle les zones nettoyées puis écrit les traductions → URL de l'image finale. */
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

  /**
   * Écrit la traduction d'un bloc, centrée dans sa bulle (fit_box) ou, à défaut, dans la zone du texte d'origine.
   * La taille de police est cherchée par dichotomie: la plus grande qui tient en largeur ET en hauteur.
   */
  function drawText(ctx, b) {
    let text = (b.translation || "").trim();
    if (!text) return;
    if (CAPS) text = text.toLocaleUpperCase("fr");
    let [x0, y0, x1, y1] = b.fit_box || b.box; // fit_box = intérieur de la bulle détectée
    let w = x1 - x0, h = y1 - y0;
    if (!b.fit_box) {
      // pas de bulle détectée: zone du texte d'origine, un peu élargie
      const extra = Math.min(w * 0.05, 8);
      if (w < h * 0.6) { x0 -= (h * 0.6 - w) / 2; w = h * 0.6; } // texte vertical (manga)
      x0 -= extra; w += 2 * extra;
      y0 -= 4; h += 8;
    } else if (w < h * 0.6) { x0 -= (h * 0.6 - w) / 2; w = h * 0.6; }
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
    // ponctuation française (« ! ? : ; » et guillemets) collée à son mot: jamais seule en début ou fin de ligne
    text = text.replace(/[ \t]+([!?:;»])/g, " $1").replace(/«[ \t]+/g, "« ");
    const words = text.split(/[ \t\r\n]+/);
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
  /** Active/désactive la traduction sur ce site (observateurs DOM + restauration des images). */
  /** Retraduit la page (langue changée...): annule d'abord les images en attente dans la file, avec les anciens réglages. */
  function restart() {
    chrome.runtime.sendMessage({ type: "flushQueue" }).catch(() => {});
    setEnabled(false);
    setEnabled(true);
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    generation++;
    inflight = 0; // les travaux en cours sont périmés: ils ne comptent plus
    if (on) {
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"] });
      scan(document);
      statsTimer = setInterval(sendStats, 1500);
      setTimeout(sendStats, 300); // le menu n'attend pas la première minuterie
    } else {
      mo.disconnect();
      io.disconnect();
      near.clear();
      restoreAll();
      if (paused) chrome.runtime.sendMessage({ type: "resumeQueue" }).catch(() => {});
      paused = false;
      originalView = false;
      clearInterval(statsTimer);
      sendStats();
    }
  }

  // Commandes du menu: { type: "koma", cmd: "pause" | "resume" | "original" | "translated" }
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "retranslate" && enabled) restart();
    if (msg.type === "koma" && enabled) {
      if (msg.cmd === "pause") setPaused(true);
      else if (msg.cmd === "resume") setPaused(false);
      else if (msg.cmd === "original") setOriginal(true);
      else if (msg.cmd === "translated") setOriginal(false);
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) pump(); });

  chrome.storage.sync.get(["sites", "font", "caps", "eco"]).then(({ sites = {}, font, caps, eco }) => { applyFont(font); CAPS = !!caps; setEco(!!eco); setEnabled(!!sites[HOST]); });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.font || ch.caps) {
      if (ch.font) applyFont(ch.font.newValue);
      if (ch.caps) CAPS = !!ch.caps.newValue;
      if (enabled) rerenderAll();
    }
    if (ch.eco) setEco(!!ch.eco.newValue);
    if (ch.siteLangs && enabled && ch.siteLangs.oldValue?.[HOST]?.src !== ch.siteLangs.newValue?.[HOST]?.src) restart(); // langue de ce site changée
    if (ch.sites) setEnabled(!!(ch.sites.newValue || {})[HOST]);
    if ((ch.src || ch.tgt) && enabled) restart(); // langue changée → retraduire
  });
})();
