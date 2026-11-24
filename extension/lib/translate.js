// KomaTranslator — traduction (portage de server/translate.py)
// Fournisseurs: google (gratuit), ollama (local), openai (API compatible: OpenAI, DeepSeek, OpenRouter, LM Studio…),
// anthropic (Claude).
(() => {
  const LANG_NAMES = {
    fr: "French", en: "English", es: "Spanish", de: "German", it: "Italian", pt: "Portuguese",
    zh: "Chinese", ja: "Japanese", ko: "Korean", auto: "the source language",
  };

  // ── Crédits / pubs de scantrad: ni effacés ni traduits ──
  const CREDITS = /(https?:\/\/|www\.|\w\.(com|net|org|io|gg|me|xyz|to|cc|fr)\b|discord|patreon|ko-?fi|paypal|\b\w+ ?scans\b|\bscantrad|read (the )?(latest|this|new|more)? ?chapters? (on|at)|translat(or|ed by)|proofread|typeset|clean(er|ed by)|\braw provider)/i;

  /**
   * Retire les blocs de crédits, et aussi leurs fragments sur la même rangée: l'OCR coupe parfois une ligne
   * (« PLEASE » | « READ THIS SERIES… EN-SCANS.COM », « - SCANS » | « TEAM ») et un fragment sans URL serait traduit seul.
   */
  function dropCredits(blocks) {
    const credit = blocks.filter((b) => CREDITS.test(b.text));
    if (!credit.length) return blocks;
    const sameRow = (a, b) => {
      const ha = a[3] - a[1], hb = b[3] - b[1];
      const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      const gap = Math.max(a[0] - b[2], b[0] - a[2]);
      return overlap > 0.5 * Math.min(ha, hb) && gap < 1.5 * Math.max(ha, hb);
    };
    return blocks.filter((b) => !credit.includes(b) && !credit.some((c) => sameRow(b.box, c.box)));
  }

  // ── Texte en MAJUSCULES (lettrage de scan) → casse normale ──
  const LATIN = /[A-Za-zÀ-ÿ]/g;
  /** Si le texte est (presque) tout en majuscules, le repasse en casse normale en gardant les noms du glossaire. */
  function decaps(text, names) {
    const letters = text.match(LATIN) || [];
    if (letters.length < 4 || letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length < 0.8 * letters.length) return text;
    let out = text.toLowerCase();
    out = out.replace(/(^|[.!?…]\s+|^["'«(\s]+)([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
    out = out.replace(/\bi\b/g, "I").replace(/\bi'/g, "I'");
    for (const n of names) {
      if (n && /[A-Za-z]/.test(n)) out = out.replace(new RegExp("\\b" + n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), n);
    }
    return out;
  }

  // ── Réseau: délai maximal + nouvelles tentatives ──
  const RETRY_STATUS = new Set([429, 502, 503, 504]);
  const OLLAMA_TIMEOUT = 180000; // un modèle local peut mettre longtemps à se charger en mémoire
  const REMOTE_TIMEOUT = 60000;  // API distante (OpenAI-compatible, Claude): au-delà, mieux vaut passer au repli
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * fetch avec délai maximal (`timeout`, 30 s par défaut) et `retries` nouvelles tentatives (2 par défaut)
   * si le réseau échoue ou si le serveur répond 429 / 502 / 503 / 504 (attente 0,6 s, 1,2 s…).
   * `retryOnTimeout: false` : un délai dépassé n'est pas retenté (inutile de réattendre un serveur qui ne répond pas).
   * Le délai ne couvre que l'attente des en-têtes, pas la lecture du corps de la réponse.
   */
  async function fetchTimeout(url, { timeout = 30000, retries = 2, retryOnTimeout = true, ...opts } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      let r;
      try {
        r = await fetch(url, { ...opts, signal: ctl.signal });
      } catch (e) {
        clearTimeout(timer);
        const timedOut = e.name === "AbortError";
        if (attempt >= retries || (timedOut && !retryOnTimeout)) throw timedOut ? new Error(`délai dépassé (${Math.round(timeout / 1000)} s)`) : e;
        await sleep(600 * 2 ** attempt);
        continue;
      }
      clearTimeout(timer);
      if (!RETRY_STATUS.has(r.status) || attempt >= retries) return r;
      await sleep(600 * 2 ** attempt);
    }
  }

  // ── Google (endpoint public gratuit) ──
  async function googleOne(text, src, tgt) {
    const sl = { zh: "zh-CN" }[src] || src;
    const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetchTimeout(u, { timeout: 15000 });
    if (!r.ok) throw new Error("Google HTTP " + r.status);
    const j = await r.json();
    return j[0].map((p) => p[0]).filter(Boolean).join("").trim();
  }
  const GOOGLE_CONCURRENCY = 3; // l'endpoint public répond 429 au-delà de quelques requêtes simultanées

  /** Comme Promise.all(items.map(fn)) mais avec au plus n appels simultanés (ordre conservé). */
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) { const k = next++; out[k] = await fn(items[k]); }
    }));
    return out;
  }

  /** Une bulle qui échoue garde son texte d'origine et marque le résultat comme dégradé (info.degraded). */
  async function google(texts, src, tgt, info = {}) {
    return mapLimit(texts, GOOGLE_CONCURRENCY, (t) => googleOne(t, src, tgt).catch(() => { info.degraded = true; return t; }));
  }

  // ── Prompt LLM ──
  /** Construit le prompt de traduction: règles + résumé + glossaire + répliques précédentes + bulles de la page numérotées. */
  function prompt(texts, src, tgt, ctx) {
    const S = LANG_NAMES[src] || src, T = LANG_NAMES[tgt] || tgt;
    const p = [
      `You translate manhwa/manhua/manga speech bubbles from ${S} into natural, fluent ${T}, like a professional scanlation team.`,
      "Rules:",
      "- The items are the text blocks of ONE comic page, in reading order: use them as context for each other.",
      "- Write natural spoken dialogue with properly conjugated verbs (never telegraphic or infinitive-style).",
      "- OCR may contain small errors: guess the intended meaning.",
      "- Always translate everything, including short interjections. Keep stutters, e.g. 'H-help!' → 'À-à l'aide !', 'W-what?' → 'Q-quoi ?'.",
      "- Commands shouted at someone stay imperatives addressed to that person ('Die!' → 'Meurs !').",
      "- Adapt interjections to the target language instead of copying them (e.g. in French: 'Yeah!' → 'Ouais !', battle cry 'Yah!/Haa!' → 'Haaa !', 'Huh?' → 'Hein ?', 'Ugh' → 'Argh').",
      "- Keep it concise (it must fit in a bubble). Sound effects → a short onomatopoeia.",
      "- Keep names and terms consistent with the glossary and previous lines.",
      "- Each item is a separate bubble: translate it in place, never move words from one item to another, even if a sentence continues in the next item.",
    ];
    if (ctx.lowercased) p.push("- The source was in ALL CAPS and was lowercased automatically: some proper names may appear in lowercase (e.g. 'ye wuxian'). Recognize them and keep them as capitalized names.");
    if (ctx.strict) p.push("- MANDATORY: in a previous attempt the glossary renderings below were NOT applied. Use them exactly, character for character, wherever the term appears.");
    if (ctx.summary) p.push("", "STORY CONTEXT:", ctx.summary);
    if (ctx.terms?.length) {
      p.push("", `GLOSSARY (always use these ${T} renderings):`);
      for (const g of ctx.terms) {
        const names = [g.orig, g.src].filter(Boolean).join(" / ");
        const note = [g.type, g.note].filter(Boolean).join(", ");
        p.push(`- ${names} → ${g.tgt}${note ? ` (${note})` : ""}`);
      }
    }
    if (ctx.history?.length) {
      p.push("", "PREVIOUS LINES (already translated, most recent last):");
      for (const [a, b] of ctx.history) p.push(`- ${a} → ${b}`);
    }
    p.push("", `Answer ONLY with a JSON object mapping each item number to its translation, e.g. {"1": "...", "2": "..."} — all ${texts.length} numbers, each translation in its own number.`,
      "", "ITEMS:", JSON.stringify(Object.fromEntries(texts.map((t, i) => [String(i + 1), t])), null, 0));
    return p.join("\n");
  }

  /** Extrait le JSON d'une réponse de LLM (ignore <think>, blocs ```json et texte autour). */
  function extractJson(raw) {
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?|```$/gm, "").trim();
    try { return JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!m) throw new Error("réponse LLM non JSON");
      return JSON.parse(m[0]);
    }
  }

  // ── Appel LLM selon le fournisseur ──
  // Température 0: la même bulle donne la même traduction (cohérence d'un passage à l'autre).
  /** keep_alive d'Ollama: durée (« 5m », « 30s »), ou nombre de secondes (« 0 » libère tout de suite, « -1 » garde toujours). */
  const keepAlive = (v) => (/^-?\d+$/.test(String(v ?? "").trim()) ? Number(v) : String(v || "").trim() || "5m");
  /** Envoie le prompt au fournisseur choisi (ollama | openai | anthropic) et renvoie le JSON de la réponse. */
  async function llmJson(text, cfg, { numCtx } = {}) {
    const p = cfg.provider;
    if (p === "ollama") {
      const base = (cfg.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/, "");
      const r = await fetchTimeout(base + "/api/chat", {
        method: "POST", timeout: OLLAMA_TIMEOUT, retries: 1,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.ollamaModel || "qwen3.5:latest",
          messages: [{ role: "user", content: text }],
          format: "json", stream: false, think: false, keep_alive: keepAlive(cfg.ollamaKeepAlive),
          options: { temperature: 0, num_ctx: numCtx || 8192 },
        }),
      });
      if (r.status === 403) throw new Error("Ollama refuse l'extension (403) : définir OLLAMA_ORIGINS, voir les options");
      if (!r.ok) throw new Error("Ollama HTTP " + r.status);
      return extractJson((await r.json()).message.content);
    }
    if (p === "openai") {
      const base = (cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
      const r = await fetchTimeout(base + "/chat/completions", {
        method: "POST", timeout: REMOTE_TIMEOUT, retries: 1, retryOnTimeout: false,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (cfg.apiKey || "none") },
        body: JSON.stringify({ model: cfg.apiModel, temperature: 0, messages: [{ role: "user", content: text }] }),
      });
      if (!r.ok) throw new Error("API HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      return extractJson((await r.json()).choices[0].message.content || "");
    }
    if (p === "anthropic") {
      const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST", timeout: REMOTE_TIMEOUT, retries: 1, retryOnTimeout: false,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.anthropicKey || "",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: cfg.anthropicModel || "claude-haiku-5-5", max_tokens: 8192, temperature: 0, messages: [{ role: "user", content: text }] }),
      });
      if (!r.ok) throw new Error("Claude HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      const j = await r.json();
      return extractJson(j.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    }
    throw new Error("fournisseur inconnu: " + p);
  }

  // ── Relecture (petites corrections seulement) ──
  /** Similarité 0..1 entre deux textes (1 − distance de Levenshtein normalisée). */
  function similarity(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (a === b) return 1;
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }
  const norm = (t) => t.replace(/[\W_]+/gu, "").toLowerCase();

  /** Deuxième passe LLM qui corrige orthographe/grammaire; on refuse les réécritures trop larges (similarité < 0,7). */
  async function review(texts, drafts, tgt, cfg) {
    const T = LANG_NAMES[tgt] || tgt;
    const pairs = Object.fromEntries(texts.map((s, i) => [String(i + 1), { source: s, draft: drafts[i] }]));
    const text = [
      `You are proofreading a ${T} translation of comic speech bubbles.`,
      `For each item, fix spelling, grammar, conjugation, accents and mistranslations in the ${T} draft (compare with the source: e.g. a command shouted at someone must stay an imperative).`,
      "Check every word carefully (French conjugation: je vais, il vaudra...). Keep the style and length.",
      'Answer ONLY with a JSON object mapping each item number to the corrected text as a plain string, e.g. {"1": "corrected text", "2": "..."}.',
      "", JSON.stringify(pairs),
    ].join("\n");
    try {
      let out = await llmJson(text, cfg);
      if (out && typeof out.translations === "object") out = out.translations;
      return drafts.map((d, i) => {
        let v = out?.[String(i + 1)];
        if (v && typeof v === "object") v = v.corrected || v.text || v.draft;
        if (typeof v !== "string" || !v.trim()) return d;
        if (similarity(v, d) < 0.7 || norm(v) === norm(texts[i])) return d; // réécriture / copie de la source refusée
        return v;
      });
    } catch (e) {
      console.warn("[KomaTranslator] relecture échouée", e);
      return drafts;
    }
  }

  // ── Traduction par LLM ──
  /** Réponse du LLM → objet { "1": "…" }, ou null si ce n'est pas un objet. */
  function asMap(out) {
    if (out && typeof out.translations === "object" && !Array.isArray(out.translations)) out = out.translations;
    return out && typeof out === "object" ? out : null;
  }

  /** Traduit `list` par le LLM en une requête → tableau de même longueur (null pour une bulle absente de la réponse). */
  async function llmBatch(list, src, tgt, cfg, c) {
    const out = asMap(await llmJson(prompt(list, src, tgt, c), cfg));
    if (!out) throw new Error("réponse LLM invalide");
    return list.map((_, i) => (typeof out[String(i + 1)] === "string" ? out[String(i + 1)] : null));
  }

  const isCjk = (s) => /[\u3000-\u9fff\uac00-\ud7af]/.test(s);
  /** Le terme du glossaire (forme d'origine ou source) apparaît-il dans ce texte ? Les mots très courts sont ignorés. */
  function mentions(text, g) {
    const t = text.toLowerCase();
    return [g.orig, g.src].some((k) => k && k.length >= (isCjk(k) ? 2 : 3) && t.includes(k.toLowerCase()));
  }

  /**
   * Vérifie le glossaire après coup: si le terme source est dans la bulle mais pas sa forme imposée dans la traduction,
   * redemande ces bulles seules au LLM avec les termes en cause (une seule relance; en cas d'échec on garde le résultat).
   */
  async function enforceGlossary(texts, result, src, tgt, cfg, ctx) {
    const terms = (ctx.terms || []).filter((g) => g.tgt);
    if (!terms.length) return result;
    const bad = [];
    texts.forEach((t, i) => {
      const miss = terms.filter((g) => mentions(t, g) && !result[i].toLowerCase().includes(g.tgt.toLowerCase()));
      if (miss.length) bad.push({ i, miss });
    });
    if (!bad.length) return result;
    const strictTerms = [...new Map(bad.flatMap((b) => b.miss).map((g) => [g.src + "|" + g.orig, g])).values()];
    try {
      const fixed = await llmBatch(bad.map((b) => texts[b.i]), src, tgt, cfg, { ...ctx, terms: strictTerms, strict: true, history: [] });
      bad.forEach((b, k) => { if (fixed[k] != null) result[b.i] = fixed[k]; });
    } catch (e) {
      console.warn("[KomaTranslator] vérification du glossaire échouée", e.message);
    }
    return result;
  }

  // ── Point d'entrée ──
  /**
   * Traduit toutes les bulles d'une page → tableau de traductions, dans le même ordre.
   * LLM si configuré: les bulles absentes de la réponse sont redemandées une fois au LLM, puis (en dernier recours)
   * traduites par Google; relecture éventuelle, puis vérification du glossaire. Si le LLM échoue, tout part chez Google
   * (l'erreur est alors gardée dans self.KomaLastError pour le popup).
   * `info.degraded` passe à true si le résultat n'est pas celui attendu (repli, bulle non traduite):
   * l'appelant ne doit alors ni le mettre en cache ni le retenir comme contexte.
   */
  async function translateAll(texts, src, tgt, cfg, ctx = {}, info = {}) {
    if (!texts.length) return [];
    const names = (ctx.terms || []).map((t) => t.src || "");
    const dec = texts.map((t) => decaps(t, names));
    const c = { ...ctx, lowercased: dec.some((t, i) => t !== texts[i]) };
    texts = dec;
    if (cfg.provider && cfg.provider !== "google") {
      try {
        const result = await llmBatch(texts, src, tgt, cfg, c);
        const absent = () => result.map((r, i) => (r == null ? i : -1)).filter((i) => i >= 0);
        let missing = absent();
        if (missing.length > texts.length / 2) throw new Error(`réponse LLM incomplète (${texts.length - missing.length}/${texts.length})`);
        if (missing.length) {
          try { // une seule relance, pour les seules bulles manquantes
            const again = await llmBatch(missing.map((i) => texts[i]), src, tgt, cfg, c);
            missing.forEach((i, k) => { if (again[k] != null) result[i] = again[k]; });
          } catch (e) { console.warn("[KomaTranslator] relance des bulles manquantes échouée", e.message); }
          missing = absent();
        }
        if (missing.length) {
          info.degraded = true;
          const fb = await google(missing.map((i) => texts[i]), src, tgt, info);
          missing.forEach((i, k) => { result[i] = fb[k]; });
        }
        let final = result;
        if (cfg.review) final = await review(texts, final, tgt, cfg);
        return await enforceGlossary(texts, final, src, tgt, cfg, c);
      } catch (e) {
        console.warn(`[KomaTranslator] ${cfg.provider} a échoué, repli sur Google:`, e.message);
        self.KomaLastError = e.message;
        info.degraded = true;
      }
    }
    return google(texts, src, tgt, info);
  }

  self.KomaTranslate = { translateAll, llmJson, fetchTimeout, dropCredits, LANG_NAMES, similarity, _internals: { decaps, extractJson, similarity, mentions } };
})();
