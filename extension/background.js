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

const resultCache = new Map(); // url|src|tgt → résultat serveur
async function translate(msg) {
  const s = await getSettings();
  const img = msg.bytes
    ? { bytes: b64ToBytes(msg.bytes), type: msg.mime || "image/png" }
    : await fetchImage(msg.url, msg.pageUrl);

  const key = `${msg.url.startsWith("blob:") ? bufToB64(img.bytes.slice(0, 64)) + img.bytes.length : msg.url}|${s.src}|${s.tgt}`;
  let data = resultCache.get(key);
  if (!data) {
    const r = await fetch(`${s.server}/translate?src=${s.src}&tgt=${s.tgt}`, {
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
