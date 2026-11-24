// KomaTranslator — arrière-plan
// Récupère les images, lance l'OCR (dans le navigateur), traduit, met en cache.
// Firefox: page d'arrière-plan (moteur OCR chargé directement).
// Chrome: service worker + document "offscreen" pour le moteur OCR (WebAssembly).

const IS_SW = typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope;
if (IS_SW) importScripts("lib/translate.js", "lib/store.js", "presets.js");

// Réglages synchronisés (chrome.storage.sync): langues et sites activés ({ "site.com": true }).
const DEFAULTS = { src: "auto", tgt: "fr", sites: {}, siteLangs: {} };
// Réglages du traducteur (chrome.storage.local, clé "cfg"; les clés API ne sont donc jamais synchronisées): voir presets.js
const CFG_DEFAULTS = KomaPresets.CFG_DEFAULTS;
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
function schedule(job, tabId) {
  return new Promise((resolve, reject) => { queue.push({ job, resolve, reject, tabId }); pump(); });
}
/** Annule les travaux en attente d'un onglet (ceux déjà lancés se terminent) → nombre annulé. */
function cancelQueued(tabId) {
  let n = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].tabId !== tabId) continue;
    queue.splice(i, 1)[0].reject(Object.assign(new Error("annulé"), { cancelled: true }));
    n++;
  }
  return n;
}

/** Onglets en pause: leurs images déjà lancées s'arrêtent avant l'OCR et avant l'appel au LLM (rien n'est dépensé de plus). */
const pausedTabs = new Set();
const cancelled = () => Object.assign(new Error("annulé"), { cancelled: true });

// ── Langue source par site ──
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
/** Langue source pour ce site: celle choisie pour lui dans le menu (siteLangs), sinon le réglage général. */
const srcFor = (s, host) => s.siteLangs?.[host]?.src || s.src;

// ── Consommation: chaque appel LLM ajoute ses jetons et son coût estimé au compteur du jour ──
KomaTranslate.setUsageHook(({ cfg, tin, tout }) =>
  KomaStore.usageAdd(KomaPresets.activeId(cfg), { req: 1, tin, tout, cost: KomaPresets.costOf(cfg, tin, tout) }));

// ── Statistiques de la page (envoyées par les content scripts, une entrée par frame) ──
const pageStats = new Map(); // tabId → Map(frameId → stats)
function setStats(tabId, frameId, stats) {
  if (tabId == null) return;
  let m = pageStats.get(tabId);
  if (!m) pageStats.set(tabId, (m = new Map()));
  m.set(frameId ?? 0, stats);
}
function aggregateStats(tabId) {
  const out = { tracked: 0, done: 0, empty: 0, busy: 0, queued: 0, failed: 0, errors: [], paused: false, original: false, enabled: false };
  for (const st of pageStats.get(tabId)?.values() || []) {
    for (const k of ["tracked", "done", "empty", "busy", "queued", "failed"]) out[k] += st[k] || 0;
    out.errors.push(...(st.errors || []));
    out.paused ||= !!st.paused; out.original ||= !!st.original; out.enabled ||= !!st.enabled;
  }
  out.errors = out.errors.slice(0, 8);
  return out;
}
chrome.tabs.onRemoved.addListener((id) => { pageStats.delete(id); pausedTabs.delete(id); });
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === "loading") pageStats.delete(id); });
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
  if (pausedTabs.has(msg.tabId)) throw cancelled();
  const s = await getSettings();
  const src = srcFor(s, msg.host || hostOf(msg.pageUrl));
  const img = msg.bytes ? { bytes: b64ToBytes(msg.bytes), type: msg.mime || "image/png" } : await fetchImage(msg.url, msg.pageUrl);
  const skey = KomaStore.seriesKey(msg.pageUrl);
  // La clé change avec l'image, les langues, le traducteur, la version du prompt et le glossaire/résumé de la série
  const sig = await KomaStore.seriesSig(await KomaStore.load(skey));
  const cacheKey = `${await KomaStore.sha1(img.bytes)}|${src}|${s.tgt}|${providerSig(s.cfg)}|p${KomaTranslate.PROMPT_VERSION}|${sig}`;

  let data = msg.fresh ? null : await KomaStore.cacheGet(cacheKey); // fresh: « retraduire cette image »
  if (!data) {
    const t0 = performance.now();
    const ocr = await runOcr(img.bytes, img.type, src);
    const blocks = KomaTranslate.dropCredits(ocr.blocks);
    const t1 = performance.now();
    const texts = blocks.map((b) => b.text);
    // Phase ordonnée par série: chaque image voit l'historique de la précédente (voir KomaStore.acquire)
    const release = await KomaStore.acquire(skey, msg.pos ?? 0);
    try {
      if (pausedTabs.has(msg.tabId)) throw cancelled(); // mis en pause pendant l'attente: aucune dépense
      const ctx = await KomaStore.contextFor(skey, texts);
      const info = {};
      let cfg = s.cfg;
      // Plafond de dépense du jour: au-delà, Google (affiché cette fois, ni mis en cache ni retenu comme contexte)
      if (cfg.provider !== "google" && Number(cfg.dailyCapCents) > 0) {
        const spent = (await KomaStore.usageCostToday()) * 100;
        if (spent >= Number(cfg.dailyCapCents)) {
          cfg = { ...cfg, provider: "google" };
          info.degraded = true;
          KomaTranslate.setLastError(`Plafond du jour atteint (${spent.toFixed(1)} ¢ sur ${cfg.dailyCapCents} ¢) : repli sur Google`);
        }
      }
      const tr = await KomaTranslate.translateAll(texts, src, s.tgt, cfg, ctx, info);
      if (cfg.provider !== "google" && blocks.length) KomaStore.usageAdd(KomaPresets.activeId(cfg), { pages: 1 });
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
  const d = await KomaStore.importWiki(key, msg.wiki, html, subpages, srcFor(s, hostOf(msg.page)), s.tgt, s.cfg);
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
  // Écran « Mémoire et cache »: le background reste le seul à écrire (même verrou que les traductions)
  async memList() { return { series: await KomaStore.listSeries() }; },
  async memClear(msg) { await KomaStore.clearPart(msg.key, msg.part); return {}; },
  async memDelete(msg) { await KomaStore.deleteSeries(msg.key); return {}; },
  async cacheInfo() { return { count: await KomaStore.cacheCount() }; },
  async cacheClear() { await KomaStore.cacheClear(); return {}; },
  async usageReset() { await chrome.storage.local.remove("usage"); return {}; },
  async usageInfo() { return { usage: await KomaStore.usageSummary() }; },
  /** Solde du compte DeepSeek (GET /user/balance: aucun jeton consommé). */
  async balance() {
    const { cfg } = await getSettings();
    const key = cfg.provider === "openai" && KomaPresets.activeId(cfg) === "deepseek" ? cfg.apiKey : cfg.profiles?.deepseek?.apiKey;
    if (!key) throw new Error("pas de clé DeepSeek");
    const r = await KomaTranslate.fetchTimeout("https://api.deepseek.com/user/balance", {
      headers: { Authorization: "Bearer " + key, Accept: "application/json" }, timeout: 15000, retries: 1,
    });
    if (r.status === 401) throw new Error("clé refusée (401)");
    if (!r.ok) throw new Error("DeepSeek HTTP " + r.status);
    const out = { ...KomaPresets.parseBalance(await r.json()), at: Date.now() };
    await chrome.storage.local.set({ balanceCache: out });
    return out;
  },
  async memGet(msg) { return { serie: await KomaStore.load(msg.key) }; },
  async memPut(msg) { await KomaStore.putSeries(msg.serie); return {}; },
  async memExport(msg) { return { data: await KomaStore.exportSeries(msg.keys) }; },
  async memImport(msg) { return { result: await KomaStore.importSeries(msg.data) }; },
  async tabStats(msg) { return { stats: aggregateStats(msg.tabId) }; },
  async pageStats(msg, sender) { setStats(sender.tab?.id, sender.frameId, msg.stats); return {}; },
  /** Pause demandée depuis la page: les images en attente de cet onglet sont retirées de la file. */
  async cancelQueue(msg, sender) { pausedTabs.add(sender.tab?.id); return { cancelled: cancelQueued(sender.tab?.id) }; },
  async resumeQueue(msg, sender) { pausedTabs.delete(sender.tab?.id); return {}; },
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
    msg.tabId = tabId;
    badge(tabId, +1);
    schedule(() => withKeepAlive(() => translate(msg)), tabId)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e), cancelled: !!e.cancelled }))
      .finally(() => badge(tabId, -1));
    return true;
  }
  const h = HANDLERS[msg.type];
  if (!h) return false;
  h(msg, sender).then((r) => sendResponse({ ok: true, ...r })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
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
