// KomaTranslator — arrière-plan
// Récupère les images, lance l'OCR (dans le navigateur), traduit, met en cache.
// Firefox: page d'arrière-plan (moteur OCR chargé directement).
// Chrome: service worker + document "offscreen" pour le moteur OCR (WebAssembly).

const IS_SW = typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope;
if (IS_SW) importScripts("lib/translate.js", "lib/store.js");

// Réglages synchronisés (chrome.storage.sync): langues et sites activés ({ "site.com": true }).
const DEFAULTS = { src: "auto", tgt: "fr", sites: {} };
// Réglages du traducteur (chrome.storage.local, clé "cfg"; les clés API ne sont donc jamais synchronisées).
const CFG_DEFAULTS = {
  provider: "google",          // google | ollama | openai | anthropic
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "qwen3.5:latest",
  apiBase: "https://api.deepseek.com/v1",
  apiKey: "",
  apiModel: "deepseek-flash",
  anthropicKey: "",
  anthropicModel: "claude-haiku-5-5",
  ollamaKeepAlive: "5m",       // durée pendant laquelle Ollama garde le modèle en VRAM après la dernière requête
  review: true,                // relecture (seulement avec un LLM)
};
const MAX_PARALLEL = 2; // images traduites en même temps (l'OCR est de toute façon sérialisé)

/** Fusionne valeurs par défaut + réglages enregistrés → { src, tgt, sites, cfg }. */
async function getSettings() {
  const [sync, local] = await Promise.all([chrome.storage.sync.get(null), chrome.storage.local.get("cfg")]);
  return { ...DEFAULTS, ...sync, cfg: { ...CFG_DEFAULTS, ...(local.cfg || {}) } };
}

// ── File d'attente ──
// Limite le nombre d'images traitées en parallèle (MAX_PARALLEL), le reste attend son tour.
let active = 0;
const queue = [];
function schedule(job) {
  return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); });
}
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const { job, resolve, reject } = queue.shift();
    active++;
    job().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

/** Garde le service worker Chrome éveillé pendant un long travail (il s'arrête après ~30 s sans appel d'API d'extension). */
async function withKeepAlive(fn) {
  const timer = setInterval(() => chrome.runtime.getPlatformInfo?.(), 20000);
  try { return await fn(); } finally { clearInterval(timer); }
}

// ── Badge: nombre d'images en cours par onglet ──
const pending = new Map();
function badge(tabId, delta) {
  if (tabId == null || tabId < 0) return;
  const n = Math.max(0, (pending.get(tabId) || 0) + delta);
  pending.set(tabId, n);
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#6b46c1" }).catch?.(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}

// ── base64 ──
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ── Règles réseau ──
// 1) beaucoup de CDN de scans refusent les requêtes sans le bon Referer
// 2) Ollama refuse les requêtes d'extensions (en-tête Origin) sauf configuration: on retire l'en-tête
/** Identifiant numérique stable (hash) de la règle réseau d'un hôte; 1 est réservé à la règle Ollama. */
function hostRuleId(host) {
  let h = 7;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) % 1000000;
  return h + 10;
}
/** Pour les requêtes de l'extension vers ce CDN d'images, impose Referer = page de lecture. */
async function setReferer(imageUrl, pageUrl) {
  const host = new URL(imageUrl).hostname;
  const id = hostRuleId(host);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id, priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: pageUrl }] },
      condition: { urlFilter: `||${host}/`, tabIds: [chrome.tabs.TAB_ID_NONE] },
    }],
  });
}
/** Retire l'en-tête Origin des requêtes vers Ollama (sinon 403); à refaire quand l'URL change. */
async function ollamaRule() {
  const { cfg } = await getSettings();
  try {
    const u = new URL(cfg.ollamaUrl);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1, priority: 2,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
        condition: { urlFilter: `|${u.protocol}//${u.host}/`, tabIds: [chrome.tabs.TAB_ID_NONE] },
      }],
    });
  } catch (e) { console.warn("[KomaTranslator] règle Ollama", e); }
}
ollamaRule();
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.cfg) ollamaRule(); });

/** Télécharge une image avec les cookies du site → { bytes, type }. */
async function fetchImage(url, pageUrl) {
  try { await setReferer(url, pageUrl); } catch (e) { console.warn("referer", e); }
  const r = await KomaTranslate.fetchTimeout(url, { credentials: "include" });
  if (!r.ok) throw new Error(`image HTTP ${r.status}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") || "image/jpeg" };
}

// ── OCR: directement (Firefox) ou via le document offscreen (Chrome) ──
let offscreenReady = null;
function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const exists = (await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] }))?.length;
      if (!exists) {
        await chrome.offscreen.createDocument({
          url: "engine/engine.html",
          reasons: ["WORKERS"],
          justification: "OCR des bulles avec ONNX Runtime (WebAssembly)",
        });
      }
    })().catch((e) => { offscreenReady = null; throw e; });
  }
  return offscreenReady;
}

/** Lance l'OCR: directement si le moteur est chargé ici (Firefox), sinon via le document offscreen (Chrome). */
async function runOcr(bytes, mime, lang) {
  if (self.KomaOCR) return self.KomaOCR.analyze(new Blob([bytes], { type: mime }), lang);
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "ocr", b64: bufToB64(bytes), mime, lang });
  if (!res?.ok) throw new Error(res?.error || "moteur OCR indisponible");
  return res.data;
}

// ── Traduction d'une image ──
/** Empreinte du traducteur (fournisseur, modèle, relecture): fait partie de la clé de cache. */
function providerSig(cfg) {
  const model = { ollama: cfg.ollamaModel, openai: cfg.apiModel, anthropic: cfg.anthropicModel }[cfg.provider] || "";
  return `${cfg.provider}|${model}|${cfg.review && cfg.provider !== "google"}`;
}

/**
 * Pipeline complet pour une image: téléchargement → cache → OCR → traduction → mémoire de la série.
 * @param msg { url, pageUrl, pos } ou { bytes (base64), mime, pageUrl, pos } pour les images blob:/data:
 *   (pos = position verticale de l'image dans la page, sert à traduire dans l'ordre de lecture)
 * @returns { data: { width, height, blocks[] }, image: data-URL de l'image d'origine }
 *   Chaque bloc: texte d'origine, traduction, boîtes, couleurs, patch effacé (voir engine/ocr.js).
 */
async function translate(msg) {
  const s = await getSettings();
  const img = msg.bytes ? { bytes: b64ToBytes(msg.bytes), type: msg.mime || "image/png" } : await fetchImage(msg.url, msg.pageUrl);
  const skey = KomaStore.seriesKey(msg.pageUrl);
  // La clé change avec l'image, les langues, le traducteur, la version du prompt et le glossaire/résumé de la série
  const sig = await KomaStore.seriesSig(await KomaStore.load(skey));
  const cacheKey = `${await KomaStore.sha1(img.bytes)}|${s.src}|${s.tgt}|${providerSig(s.cfg)}|p${KomaTranslate.PROMPT_VERSION}|${sig}`;

  let data = await KomaStore.cacheGet(cacheKey);
  if (!data) {
    const t0 = performance.now();
    const ocr = await runOcr(img.bytes, img.type, s.src);
    const blocks = KomaTranslate.dropCredits(ocr.blocks);
    const t1 = performance.now();
    const texts = blocks.map((b) => b.text);
    // Phase ordonnée par série: chaque image voit l'historique de la précédente (voir KomaStore.acquire)
    const release = await KomaStore.acquire(skey, msg.pos ?? 0);
    try {
      const ctx = await KomaStore.contextFor(skey, texts);
      const info = {};
      const tr = await KomaTranslate.translateAll(texts, s.src, s.tgt, s.cfg, ctx, info);
      blocks.forEach((b, i) => (b.translation = tr[i]));
      data = { width: ocr.width, height: ocr.height, blocks };
      if (info.degraded) {
        // repli ou bulle non traduite: affiché cette fois, mais ni mis en cache ni retenu comme contexte
        console.warn("[KomaTranslator] traduction dégradée, non mise en cache");
      } else {
        if (blocks.length) await KomaStore.addHistory(skey, texts.map((t, i) => [t, tr[i]]));
        await KomaStore.cachePut(cacheKey, data);
      }
    } finally {
      release();
    }
    console.log(`[KomaTranslator] ${ocr.width}x${ocr.height}: ${blocks.length} bulles, OCR ${Math.round(t1 - t0)} ms, trad ${Math.round(performance.now() - t1)} ms`);
  }
  // corrections manuelles de la série (toujours prioritaires, même sur le cache)
  const { corrections } = await KomaStore.load(skey);
  data = { ...data, blocks: data.blocks.map((b) => ({ ...b, translation: KomaStore.bestCorrection(corrections, b.text) ?? b.translation })) };
  return { data, image: `data:${img.type};base64,${bufToB64(img.bytes)}` };
}

// ── Wiki ──
/** Télécharge une page wiki et ne garde que son contenu (MediaWiki/Fandom), tronqué à 300 ko. */
async function fetchText(url) {
  try {
    const r = await KomaTranslate.fetchTimeout(url, { credentials: "include", retries: 1 });
    if (!r.ok) return "";
    let t = await r.text();
    const i = t.indexOf('id="mw-content-text"'); // on ne garde que le contenu (MediaWiki / Fandom)
    if (i > 0) t = t.slice(i);
    return t.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").slice(0, 300000);
  } catch {
    return "";
  }
}

// Liens vers les autres articles du même wiki (personnages, techniques, lieux…)
// (même dossier d'URL, sans « : », sans sous-chemin, sans paramètres)
function wikiLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const prefix = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1); // ex: "/wiki/"
  const seen = new Set([base.origin + base.pathname]);
  const out = [];
  for (const m of html.matchAll(/href="([^"#]+)/g)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, "&"), base); } catch { continue; }
    const name = decodeURIComponent(u.pathname.slice(prefix.length));
    if (u.origin !== base.origin || !u.pathname.startsWith(prefix) || u.search) continue;
    if (!name || name.includes(":") || name.includes("/") || /^(Main_Page|.*_Wiki)$/i.test(name)) continue;
    const key = u.origin + u.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Comme Promise.all(items.map(fn)) mais avec au plus n appels simultanés (ordre conservé). */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Lit le wiki (et jusqu'à 20 sous-pages) puis demande au LLM d'en tirer glossaire + résumé pour la série. */
async function importWiki(msg) {
  const s = await getSettings();
  if (s.cfg.provider === "google") throw new Error("l'import wiki nécessite un LLM (Ollama ou clé API) : voir les options");
  const html = await fetchText(msg.wiki);
  if (!html) throw new Error("impossible de lire la page wiki");
  let subpages = [];
  if (msg.subpages) {
    const links = wikiLinks(html, msg.wiki).slice(0, 20);
    subpages = (await mapLimit(links, 4, async (url) => ({ url, html: await fetchText(url) }))).filter((p) => p.html);
  }
  const key = KomaStore.seriesKey(msg.page);
  const d = await KomaStore.importWiki(key, msg.wiki, html, subpages, s.src, s.tgt, s.cfg);
  return { key, terms: d.glossary.length, summary: d.summary, wiki: d.wiki };
}

// ── Messages ──
// Protocole: chaque message { type, ... } reçoit { ok: true, ... } ou { ok: false, error }.
// « translate » (venant du content script) passe par la file d'attente; les autres types sont dans HANDLERS.
const HANDLERS = {
  async series(msg) {
    const d = await KomaStore.load(KomaStore.seriesKey(msg.page));
    return { key: d.key, wiki: d.wiki, terms: d.glossary.length, summary: d.summary };
  },
  async seriesFull(msg) { return { data: await KomaStore.load(KomaStore.seriesKey(msg.page)) }; },
  async seriesSave(msg) { await KomaStore.saveEdit(KomaStore.seriesKey(msg.page), msg.body); return {}; },
  importWiki: (msg) => withKeepAlive(() => importWiki(msg)),
  async correct(msg) { await KomaStore.setCorrection(KomaStore.seriesKey(msg.page), msg.text, msg.translation); return {}; },
  async retranslate(msg) {
    await KomaStore.cacheClear();
    await chrome.tabs.sendMessage(msg.tabId, { type: "retranslate" });
    return {};
  },
  async health() {
    const { cfg } = await getSettings();
    const model = { ollama: cfg.ollamaModel, openai: cfg.apiModel, anthropic: cfg.anthropicModel }[cfg.provider] || "";
    const stored = (await chrome.storage.session?.get("komaLastError"))?.komaLastError;
    return { provider: cfg.provider, model, lastError: self.KomaLastError || stored || "" };
  },
  /** Demande à Ollama de décharger le modèle de la VRAM tout de suite (keep_alive: 0). */
  async unloadOllama(msg) {
    const cfg = { ...CFG_DEFAULTS, ...msg.cfg };
    const base = cfg.ollamaUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const r = await KomaTranslate.fetchTimeout(base + "/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.ollamaModel, keep_alive: 0 }), timeout: 15000, retries: 0,
    });
    if (r.status === 403) throw new Error("Ollama refuse l'extension (403) : voir les options");
    if (!r.ok) throw new Error("Ollama HTTP " + r.status);
    return {};
  },
  async testProvider(msg) {
    const cfg = { ...CFG_DEFAULTS, ...msg.cfg };
    KomaTranslate.setLastError("");
    const t = performance.now();
    const out = await KomaTranslate.translateAll(["Hey! W-what are you doing here?!"], "en", "fr", cfg, {});
    if (cfg.provider !== "google" && self.KomaLastError) throw new Error(self.KomaLastError);
    return { result: out[0], ms: Math.round(performance.now() - t) };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return false; // destiné au document offscreen
  if (msg.type === "translate") {
    const tabId = sender.tab?.id;
    badge(tabId, +1);
    schedule(() => withKeepAlive(() => translate(msg)))
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }))
      .finally(() => badge(tabId, -1));
    return true;
  }
  const h = HANDLERS[msg.type];
  if (!h) return false;
  h(msg).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});

// Raccourci clavier: (dés)active le site courant
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "toggle-site" || !tab?.url) return;
  const host = new URL(tab.url).hostname;
  const { sites = {} } = await chrome.storage.sync.get("sites");
  sites[host] = !sites[host];
  await chrome.storage.sync.set({ sites });
});

// Première installation: ouvrir les options
chrome.runtime.onInstalled.addListener((d) => { if (d.reason === "install") chrome.runtime.openOptionsPage(); });
