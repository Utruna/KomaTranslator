// KomaTranslator — stockage local: mémoire par série (chrome.storage.local) + cache des pages (IndexedDB)
(() => {
  const HISTORY_MAX = 30;
  const CHAPTER = /(chap|chapter|chapitre|episode|ep[-_]?\d|ch[-_.]?\d|^\d+$|^c\d+$|viewer|read)/i;

  /**
   * Identifiant d'une série déduit de l'URL: hôte + segments du chemin avant le premier segment « chapitre »
   * (3 max). Ex: site.com/manga/ma-serie/chapitre-12 → "site.com/manga/ma-serie".
   */
  function seriesKey(pageUrl) {
    if (!pageUrl) return "inconnu";
    let u;
    try { u = new URL(pageUrl); } catch { return "inconnu"; }
    const kept = [];
    for (const seg of u.pathname.split("/").filter(Boolean)) {
      if (CHAPTER.test(seg)) break;
      kept.push(decodeURIComponent(seg));
    }
    return [u.hostname || "local", ...kept.slice(0, 3)].join("/");
  }

  // Une série = { key, wiki, summary, glossary[{src,orig,tgt,type,note}], corrections{texte→traduction}, history[[orig,trad,langue]],
  //   lang (langue cible du glossaire et des corrections; vide = « fr », la langue par défaut des anciennes séries) }
  const sk = (key) => "series:" + key;
  const empty = (key) => ({ key, wiki: "", summary: "", glossary: [], corrections: {}, history: [], lang: "" });
  /** Langue cible dans laquelle le glossaire et les corrections de la série ont été faits. */
  const langOf = (d) => d.lang || "fr";

  async function load(key) {
    const r = await chrome.storage.local.get(sk(key));
    return { ...empty(key), ...(r[sk(key)] || {}) };
  }
  async function save(data) {
    await chrome.storage.local.set({ [sk(data.key)]: data });
  }

  // sérialise les modifications (plusieurs pages traduites en parallèle)
  let chain = Promise.resolve();
  const locked = (fn) => (chain = chain.then(fn, fn));

  const addHistory = (key, pairs) => locked(async () => {
    const d = await load(key);
    d.history = [...d.history, ...pairs].slice(-HISTORY_MAX);
    await save(d);
  });

  const setCorrection = (key, text, translation, tgt) => locked(async () => {
    const d = await load(key);
    if (!Object.keys(d.corrections).length && !d.glossary.length && tgt) d.lang = tgt; // série neuve: sa langue est celle-ci
    d.corrections[text] = translation;
    await save(d);
  });

  const saveEdit = (key, body) => locked(async () => {
    const d = await load(key);
    if (body.glossary) d.glossary = body.glossary.filter((t) => t.src && t.tgt)
      .map((t) => Object.fromEntries(["src", "orig", "tgt", "type", "note"].map((k) => [k, String(t[k] || "")])));
    if ("summary" in body) d.summary = String(body.summary);
    if (body.corrections) d.corrections = Object.fromEntries(Object.entries(body.corrections).filter(([k, v]) => k && v));
    if (body.clear_history) d.history = [];
    await save(d);
  });

  /** Contexte donné au LLM pour une page: résumé, glossaire (filtré aux termes présents si > 60), 12 dernières répliques. */
  async function contextFor(key, texts, tgt) {
    const d = await load(key);
    const page = texts.join("\n").toLowerCase();
    let terms = d.glossary;
    if (terms.length > 60) terms = terms.filter((t) => ["orig", "src"].some((k) => t[k] && page.includes(t[k].toLowerCase())));
    // Autre langue cible que celle de la mémoire: pas d'exemples ni de rendus dans l'ancienne langue (le LLM la recopierait).
    // Le glossaire ne garde que les noms (cohérence des personnages), l'historique que les répliques de cette langue.
    const same = !tgt || tgt === langOf(d);
    if (!same) terms = terms.map((t) => ({ ...t, tgt: "" }));
    const history = d.history.filter((h) => !tgt || (h[2] || langOf(d)) === tgt).slice(-12).map((h) => [h[0], h[1]]);
    return { summary: d.summary, terms, history, corrections: same ? d.corrections : {} };
  }

  /** Corrections manuelles applicables pour cette langue cible (aucune si la série a été corrigée dans une autre langue). */
  async function correctionsFor(key, tgt) {
    const d = await load(key);
    return !tgt || tgt === langOf(d) ? d.corrections : {};
  }

  // ── Gestion de la mémoire (écran « Mémoire et cache ») ──
  /** Toutes les séries enregistrées, de la plus volumineuse à la plus petite. */
  async function listSeries() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all).filter(([k]) => k.startsWith("series:")).map(([k, v]) => ({
      key: v.key || k.slice("series:".length),
      wiki: v.wiki || "",
      terms: (v.glossary || []).length,
      summary: !!v.summary,
      corrections: Object.keys(v.corrections || {}).length,
      history: (v.history || []).length,
      // langues cibles présentes: celle du glossaire / des corrections, et celles des répliques retenues
      langs: [...new Set([
        ...((v.glossary || []).length || Object.keys(v.corrections || {}).length ? [langOf(v)] : []),
        ...(v.history || []).map((h) => h[2] || langOf(v)),
      ])].sort(),
      bytes: JSON.stringify(v).length,
    })).sort((a, b) => b.bytes - a.bytes);
  }

  /** Efface une partie d'une série: « wiki » (URL, résumé et glossaire), « corrections » ou « history ». */
  const clearPart = (key, part) => locked(async () => {
    const d = await load(key);
    if (part === "wiki") { d.wiki = ""; d.summary = ""; d.glossary = []; }
    else if (part === "corrections") d.corrections = {};
    else if (part === "history") d.history = [];
    else throw new Error("partie inconnue: " + part);
    await save(d);
  });

  /** Supprime une série entière (glossaire, résumé, corrections, historique). */
  const deleteSeries = (key) => locked(() => chrome.storage.local.remove(sk(key)));

  // ── Export / import / restauration d'une série ──
  const str = (v, n) => String(v ?? "").slice(0, n);
  const cleanTerm = (t) => Object.fromEntries(["src", "orig", "tgt", "type", "note"].map((k) => [k, str(t?.[k], 300)]));

  /** Série valide (champs connus seulement, tailles bornées) à partir d'un objet quelconque, ou null s'il n'a pas de clé. */
  function sanitizeSeries(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.key !== "string" || !raw.key.trim()) return null;
    const corr = raw.corrections && typeof raw.corrections === "object" && !Array.isArray(raw.corrections) ? raw.corrections : {};
    return {
      key: str(raw.key.trim(), 300),
      wiki: str(raw.wiki, 500),
      summary: str(raw.summary, 5000),
      glossary: (Array.isArray(raw.glossary) ? raw.glossary : []).filter((t) => t && t.src && t.tgt).slice(0, 2000).map(cleanTerm),
      corrections: Object.fromEntries(Object.entries(corr).filter(([k, v]) => k && v).slice(0, 5000).map(([k, v]) => [str(k, 1000), str(v, 1000)])),
      history: (Array.isArray(raw.history) ? raw.history : []).filter((p) => Array.isArray(p) && p.length >= 2).slice(-HISTORY_MAX)
        .map((p) => (p[2] ? [str(p[0], 1000), str(p[1], 1000), str(p[2], 10)] : [str(p[0], 1000), str(p[1], 1000)])),
      lang: str(raw.lang, 10),
    };
  }

  /** Remet une série telle quelle (annulation d'une suppression). */
  const putSeries = (serie) => locked(async () => {
    const c = sanitizeSeries(serie);
    if (!c) throw new Error("série invalide");
    await save(c);
  });

  /** Fichier d'export: les séries demandées (toutes par défaut), sans l'historique des répliques (inutile à partager). */
  async function exportSeries(keys) {
    const all = await listSeries();
    const series = [];
    for (const s of all) {
      if (keys && !keys.includes(s.key)) continue;
      const d = await load(s.key);
      series.push({ key: d.key, wiki: d.wiki, summary: d.summary, glossary: d.glossary, corrections: d.corrections, lang: d.lang });
    }
    return { app: "KomaTranslator", version: 1, exportedAt: new Date().toISOString(), series };
  }

  /**
   * Importe un fichier d'export en fusionnant avec l'existant: glossaire par terme source (l'importé l'emporte),
   * corrections (les tiennes l'emportent), résumé et wiki gardés s'ils existent déjà, historique inchangé.
   * → { added (séries nouvelles), merged (séries existantes), skipped (entrées invalides) }.
   */
  const importSeries = (data) => locked(async () => {
    if (!data || data.app !== "KomaTranslator" || !Array.isArray(data.series)) throw new Error("ce fichier n'est pas un export KomaTranslator");
    const out = { added: 0, merged: 0, skipped: 0 };
    for (const raw of data.series.slice(0, 500)) {
      const c = sanitizeSeries(raw);
      if (!c) { out.skipped++; continue; }
      const existing = (await chrome.storage.local.get(sk(c.key)))[sk(c.key)];
      if (!existing) { await save(c); out.added++; continue; }
      const d = { ...empty(c.key), ...existing };
      const terms = new Map(d.glossary.map((t) => [t.src.toLowerCase(), t]));
      for (const t of c.glossary) terms.set(t.src.toLowerCase(), t);
      d.glossary = [...terms.values()];
      d.corrections = { ...c.corrections, ...d.corrections };
      d.summary = d.summary || c.summary;
      d.wiki = d.wiki || c.wiki;
      d.lang = d.lang || c.lang;
      await save(d);
      out.merged++;
    }
    return out;
  });

  // ── Consommation: jetons et coût estimé, par jour (UTC) et par traducteur ──
  const USAGE_DAYS = 62;
  const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);
  let usageChain = Promise.resolve();

  /** Ajoute à la consommation du jour pour ce traducteur: { req, tin, tout, pages, cost (dollars; null si le tarif est inconnu) }. */
  function usageAdd(id, delta, now = new Date()) {
    const run = async () => {
      const { usage = {} } = await chrome.storage.local.get("usage");
      const rec = (usage[dayOf(now)] ||= {});
      const r = (rec[id] ||= { req: 0, tin: 0, tout: 0, pages: 0, cost: 0 });
      for (const k of ["req", "tin", "tout", "pages"]) r[k] += delta[k] || 0;
      if (delta.cost != null) r.cost += delta.cost;
      for (const d of Object.keys(usage).sort().slice(0, -USAGE_DAYS)) delete usage[d];
      await chrome.storage.local.set({ usage });
    };
    return (usageChain = usageChain.then(run, run));
  }
  const usageAll = async () => (await chrome.storage.local.get("usage")).usage || {};

  /** Dollars dépensés aujourd'hui (tous traducteurs dont le tarif est connu). */
  async function usageCostToday(now = new Date()) {
    return Object.values((await usageAll())[dayOf(now)] || {}).reduce((s, r) => s + (r.cost || 0), 0);
  }

  /** { today: { id: rec }, month: { id: rec }, days: [{ day, req, tin, tout, pages, cost }] (récents d'abord) }. */
  async function usageSummary(now = new Date()) {
    const usage = await usageAll();
    const sum = (recs) => {
      const out = {};
      for (const rec of recs) for (const [id, r] of Object.entries(rec)) {
        const o = (out[id] ||= { req: 0, tin: 0, tout: 0, pages: 0, cost: 0 });
        for (const k of Object.keys(o)) o[k] += r[k] || 0;
      }
      return out;
    };
    const month = dayOf(now).slice(0, 7);
    const days = Object.keys(usage).sort().reverse().map((day) => {
      const t = Object.values(sum([usage[day]]));
      const tot = { day, req: 0, tin: 0, tout: 0, pages: 0, cost: 0 };
      for (const r of t) for (const k of ["req", "tin", "tout", "pages", "cost"]) tot[k] += r[k];
      return tot;
    });
    return { today: sum([usage[dayOf(now)] || {}]), month: sum(Object.keys(usage).filter((d) => d.startsWith(month)).map((d) => usage[d])), days };
  }

  /** Empreinte (8 hex) de ce qui change la traduction d'une page: résumé + glossaire de la série (pas l'historique). */
  async function seriesSig(serie) {
    return (await sha1(new TextEncoder().encode(JSON.stringify([serie.summary || "", serie.glossary || []])))).slice(0, 8);
  }

  const normText = (t) => String(t).replace(/[\W_]+/gu, "").toLowerCase();

  /**
   * Correction manuelle pour un texte d'origine: exacte, ou à la ponctuation/casse près, ou (textes de 8 lettres et plus)
   * proche à 88 % (l'OCR lit parfois la même bulle avec une lettre de différence). undefined si aucune.
   */
  function bestCorrection(corrections, text) {
    if (corrections[text] != null) return corrections[text];
    const n = normText(text);
    if (!n) return undefined;
    const sim = self.KomaTranslate?.similarity;
    let best, bestScore = 0.88;
    for (const [k, v] of Object.entries(corrections)) {
      const nk = normText(k);
      if (nk === n) return v;
      if (!sim || n.length < 8 || Math.abs(nk.length - n.length) > 0.15 * Math.max(nk.length, n.length)) continue;
      const s = sim(nk, n);
      if (s >= bestScore) { best = v; bestScore = s; }
    }
    return best;
  }

  // ── Ordre de traduction par série ──
  // Les images d'une même série passent l'une après l'autre dans la phase « contexte → traduction → historique »
  // (chacune voit les répliques de la précédente). Parmi celles qui attendent, la plus haute dans la page passe d'abord.
  const seriesQueues = new Map(); // key → { busy, waiting: [{ pos, go }] }

  /** Attend son tour pour la série `key` (pos = position de l'image dans la page) → fonction `release()` à appeler à la fin. */
  function acquire(key, pos = 0) {
    let q = seriesQueues.get(key);
    if (!q) seriesQueues.set(key, (q = { busy: false, waiting: [] }));
    return new Promise((resolve) => {
      const release = () => {
        const next = q.waiting.sort((a, b) => a.pos - b.pos).shift();
        if (next) next.go();
        else { q.busy = false; seriesQueues.delete(key); }
      };
      const go = () => resolve(release);
      if (q.busy) q.waiting.push({ pos, go });
      else { q.busy = true; go(); }
    });
  }

  // ── Import wiki ──
  /** HTML d'un wiki → texte brut (contenu de l'article seulement), tronqué à `limit` caractères. */
  function wikiText(html, limit = 14000) {
    let s = html;
    const i = s.search(/id="mw-content-text"/i);
    if (i > 0) s = s.slice(i);
    s = s.replace(/<(script|style|noscript|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
      .replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n");
    return s.trim().slice(0, limit);
  }

  function extractPrompt(text, src, tgt, withSummary) {
    const N = self.KomaTranslate.LANG_NAMES;
    const S = N[src] || src, T = N[tgt] || tgt;
    return [
      "Below is text from wiki pages about a comic (manhua / manhwa / manga).",
      `Build a translation glossary for translating this comic from ${S} into ${T}.`,
      "Include: character names, places, organizations, techniques / spells / skills, ranks / cultivation levels, items, monsters, classes. Skip wiki navigation, chapter lists, staff / publisher info.",
      '- "src": the term as written in the wiki',
      "- \"orig\": the term in the comic's original script (Chinese characters / Hangul / Kana); use your own knowledge of the series if the wiki only gives a romanization; empty if unsure",
      `- "tgt": the rendering to use IN ${T.toUpperCase()} (translate common words like Academy / Sect / Tribe / King / Sword into that language; keep personal names romanized)`,
      '- "type": character | place | technique | rank | organization | item | creature | other',
      "- \"note\": very short (gender for characters: 'male' / 'female')",
      ...(withSummary ? ['Also write "summary": 3-5 sentences: premise + main characters with gender and relationships.'] : []),
      "Answer ONLY with JSON: {" + (withSummary ? '"summary": "...", ' : "") + '"terms": [{"src": "...", "orig": "...", "tgt": "...", "type": "...", "note": "..."}]}',
      "", "WIKI TEXT:", text,
    ].join("\n");
  }

  /** Découpe le wiki en lots, fait extraire termes + résumé par le LLM, puis fusionne dans le glossaire (sans doublon sur `src`). */
  async function importWiki(key, url, mainHtml, subpages, src, tgt, cfg, log = console.log) {
    const chunks = [wikiText(mainHtml, 12000)];
    let cur = "";
    for (const sp of subpages || []) {
      const t = wikiText(sp.html, 4000);
      if (cur && cur.length + t.length > 10000) { chunks.push(cur); cur = ""; }
      cur += `\n=== ${decodeURIComponent(sp.url.split("/").pop())} ===\n${t}`;
    }
    if (cur) chunks.push(cur);

    const terms = [], errors = [];
    let summary = "";
    for (let i = 0; i < chunks.length; i++) {
      log(`[wiki] lot ${i + 1}/${chunks.length}`);
      try {
        const out = await self.KomaTranslate.llmJson(extractPrompt(chunks[i], src, tgt, i === 0), cfg, { numCtx: 12288 });
        if (i === 0 && out?.summary) summary = String(out.summary);
        for (const t of out?.terms || []) if (t && t.src && t.tgt) terms.push(t);
      } catch (e) { errors.push(e.message); }
    }
    if (!terms.length && errors.length) throw new Error("extraction impossible: " + errors[0]);
    return locked(async () => {
      const d = await load(key);
      const known = new Map(d.glossary.map((t) => [t.src.toLowerCase(), t]));
      for (const t of terms) known.set(String(t.src).toLowerCase(), Object.fromEntries(["src", "orig", "tgt", "type", "note"].map((k) => [k, String(t[k] || "")])));
      d.glossary = [...known.values()];
      if (summary) d.summary = summary;
      d.wiki = url;
      d.lang = tgt; // les rendus du glossaire sont dans cette langue
      await save(d);
      return d;
    });
  }

  // ── Cache des pages traduites (IndexedDB) ──
  // Clé = sha1 de l'image + langues + fournisseur; valeur = résultat OCR+traduction. Les plus anciens sont purgés au-delà de CACHE_MAX.
  const CACHE_MAX = 2000;
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open("komatranslator", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("pages", { keyPath: "k" }).createIndex("t", "t");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction("pages", mode);
      const out = fn(t.objectStore("pages"));
      t.oncomplete = () => res(out?.result);
      t.onerror = () => rej(t.error);
    });
  };
  async function cacheGet(k) {
    try { return (await tx("readonly", (s) => s.get(k)))?.v || null; } catch { return null; }
  }
  async function cachePut(k, v) {
    try {
      await tx("readwrite", (s) => s.put({ k, v, t: Date.now() }));
      const n = await tx("readonly", (s) => s.count());
      if (n > CACHE_MAX) {
        await tx("readwrite", (s) => {
          let left = n - CACHE_MAX;
          s.index("t").openCursor().onsuccess = (e) => {
            const c = e.target.result;
            if (c && left-- > 0) { c.delete(); c.continue(); }
          };
        });
      }
    } catch (e) { console.warn("[KomaTranslator] cache", e); }
  }
  /** Nombre de pages en cache (0 si IndexedDB est indisponible). */
  async function cacheCount() {
    try { return (await tx("readonly", (s) => s.count())) || 0; } catch { return 0; }
  }
  async function cacheClear() {
    try { await tx("readwrite", (s) => s.clear()); } catch { /* rien */ }
  }

  async function sha1(bytes) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  self.KomaStore = { seriesKey, load, save, addHistory, setCorrection, saveEdit, contextFor, correctionsFor, seriesSig, bestCorrection, listSeries, clearPart, deleteSeries, sanitizeSeries, putSeries, exportSeries, importSeries, usageAdd, usageCostToday, usageSummary, cacheCount, acquire, importWiki, cacheGet, cachePut, cacheClear, sha1 };
})();
