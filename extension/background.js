// KomaTranslator Live — service worker
// Récupère les images (sans contrainte CORS), les envoie au serveur local, renvoie le résultat.

const DEFAULTS = { server: "http://127.0.0.1:8765", src: "auto", tgt: "fr", sites: {} };
const MAX_PARALLEL = 2;

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
}

// ── File d'attente (le serveur traite une image à la fois de toute façon) ──
let active = 0;
const queue = [];
function schedule(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const { job, resolve, reject } = queue.shift();
    active++;
    job().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

// ── Badge: nombre d'images en cours par onglet ──
const pending = new Map();
function badge(tabId, delta) {
  if (tabId == null || tabId < 0) return;
  const n = Math.max(0, (pending.get(tabId) || 0) + delta);
  pending.set(tabId, n);
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#6b46c1" });
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}

// ── Utilitaires base64 ──
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

// Beaucoup de CDN de scans refusent les requêtes sans le bon Referer.
function hostRuleId(host) {
  let h = 7;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) % 1000000;
  return h + 1;
}
async function setReferer(imageUrl, pageUrl) {
  const host = new URL(imageUrl).hostname;
  const id = hostRuleId(host);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: pageUrl }] },
      condition: { urlFilter: `||${host}/`, tabIds: [chrome.tabs.TAB_ID_NONE] },
    }],
  });
}

async function fetchImage(url, pageUrl) {
  try { await setReferer(url, pageUrl); } catch (e) { console.warn("referer", e); }
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`image HTTP ${r.status}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") || "image/jpeg" };
}

// ── Wiki ──
async function fetchText(url) {
  try {
    const r = await fetch(url, { credentials: "include" });
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

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const resultCache = new Map(); // url|src|tgt → résultat serveur
async function translate(msg) {
  const s = await getSettings();
  const img = msg.bytes
    ? { bytes: b64ToBytes(msg.bytes), type: msg.mime || "image/png" }
    : await fetchImage(msg.url, msg.pageUrl);

  const key = `${msg.url.startsWith("blob:") ? bufToB64(img.bytes.slice(0, 64)) + img.bytes.length : msg.url}|${s.src}|${s.tgt}`;
  let data = resultCache.get(key);
  if (!data) {
    const r = await fetch(`${s.server}/translate?src=${s.src}&tgt=${s.tgt}&page=${encodeURIComponent(msg.pageUrl || "")}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: img.bytes,
    });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || `serveur HTTP ${r.status}`);
    resultCache.set(key, data);
    if (resultCache.size > 200) resultCache.delete(resultCache.keys().next().value);
  }
  return { data, image: `data:${img.type};base64,${bufToB64(img.bytes)}` };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "translate") {
    const tabId = sender.tab?.id;
    badge(tabId, +1);
    schedule(() => translate(msg))
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }))
      .finally(() => badge(tabId, -1));
    return true; // réponse asynchrone
  }
  if (msg.type === "series") {
    getSettings()
      .then((s) => fetch(`${s.server}/series?page=${encodeURIComponent(msg.page)}`))
      .then((r) => r.json())
      .then((j) => sendResponse({ ok: true, ...j }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "importWiki") {
    (async () => {
      const s = await getSettings();
      // le navigateur lit la page wiki (comme une visite normale) et transmet son contenu
      const html = await fetchText(msg.wiki);
      let subpages = [];
      if (msg.subpages && html) {
        const links = wikiLinks(html, msg.wiki).slice(0, 20);
        const pages = await mapLimit(links, 4, async (url) => ({ url, html: await fetchText(url) }));
        subpages = pages.filter((p) => p.html);
      }
      return fetch(`${s.server}/series/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: msg.page, wiki: msg.wiki, html, subpages, src: s.src, tgt: s.tgt }),
      });
    })()
      .then(async (r) => ({ r, j: await r.json() }))
      .then(({ r, j }) => sendResponse(r.ok ? { ok: true, ...j } : { ok: false, error: j.error }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "retranslate") {
    getSettings()
      .then((s) => fetch(`${s.server}/cache/clear`, { method: "POST" }))
      .then(() => {
        resultCache.clear();
        return chrome.tabs.sendMessage(msg.tabId, { type: "retranslate" });
      })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "correct") {
    getSettings()
      .then((s) => fetch(`${s.server}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: msg.page, text: msg.text, translation: msg.translation }),
      }))
      .then(() => {
        // le cache de l'extension garderait l'ancienne traduction
        resultCache.clear();
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === "health") {
    getSettings()
      .then((s) => fetch(`${s.server}/health`))
      .then((r) => r.json())
      .then((j) => sendResponse({ ok: true, ...j }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});

// Raccourci clavier: (dés)active le site courant
chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== "toggle-site" || !tab?.url) return;
  const host = new URL(tab.url).hostname;
  const { sites = {} } = await chrome.storage.sync.get("sites");
  sites[host] = !sites[host];
  await chrome.storage.sync.set({ sites });
});
