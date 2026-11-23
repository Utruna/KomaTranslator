// KomaTranslator — stockage local: mémoire par série (chrome.storage.local) + cache des pages (IndexedDB)
(() => {
  const HISTORY_MAX = 30;
  const CHAPTER = /(chap|chapter|chapitre|episode|ep[-_]?\d|ch[-_.]?\d|^\d+$|^c\d+$|viewer|read)/i;

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

  const sk = (key) => "series:" + key;
  const empty = (key) => ({ key, wiki: "", summary: "", glossary: [], corrections: {}, history: [] });

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

  const setCorrection = (key, text, translation) => locked(async () => {
    const d = await load(key);
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

  async function contextFor(key, texts) {
    const d = await load(key);
    const page = texts.join("\n").toLowerCase();
    let terms = d.glossary;
    if (terms.length > 60) terms = terms.filter((t) => ["orig", "src"].some((k) => t[k] && page.includes(t[k].toLowerCase())));
    return { summary: d.summary, terms, history: d.history.slice(-12), corrections: d.corrections };
  }

  // ── Import wiki ──
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
      await save(d);
      return d;
    });
  }

  // ── Cache des pages traduites (IndexedDB) ──
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
  async function cacheClear() {
    try { await tx("readwrite", (s) => s.clear()); } catch { /* rien */ }
  }

  async function sha1(bytes) {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  self.KomaStore = { seriesKey, load, save, addHistory, setCorrection, saveEdit, contextFor, importWiki, cacheGet, cachePut, cacheClear, sha1 };
})();
