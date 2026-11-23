// KomaTranslator — traduction (portage de server/translate.py)
// Fournisseurs: google (gratuit), ollama (local), openai (API compatible: OpenAI, DeepSeek, OpenRouter, LM Studio…),
// anthropic (Claude).
(() => {
  const LANG_NAMES = {
    fr: "French", en: "English", es: "Spanish", de: "German", it: "Italian", pt: "Portuguese",
    zh: "Chinese", ja: "Japanese", ko: "Korean", auto: "the source language",
  };

  // ── Texte en MAJUSCULES (lettrage de scan) → casse normale ──
  const LATIN = /[A-Za-zÀ-ÿ]/g;
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

  // ── Google (endpoint public gratuit) ──
  async function googleOne(text, src, tgt) {
    const sl = { zh: "zh-CN" }[src] || src;
    const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tgt}&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error("Google HTTP " + r.status);
    const j = await r.json();
    return j[0].map((p) => p[0]).filter(Boolean).join("").trim();
  }
  async function google(texts, src, tgt) {
    return Promise.all(texts.map((t) => googleOne(t, src, tgt).catch(() => t)));
  }

  // ── Prompt LLM ──
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

  function extractJson(raw) {
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().replace(/^```(?:json)?|```$/gm, "").trim();
    try { return JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!m) throw new Error("réponse LLM non JSON");
      return JSON.parse(m[0]);
    }
  }

  // ── Appel LLM selon le fournisseur ──
  async function llmJson(text, cfg, { numCtx } = {}) {
    const p = cfg.provider;
    if (p === "ollama") {
      const base = (cfg.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/, "");
      const r = await fetch(base + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: cfg.ollamaModel || "qwen3.5:latest",
          messages: [{ role: "user", content: text }],
          format: "json", stream: false, think: false, keep_alive: "30m",
          options: { temperature: 0.3, num_ctx: numCtx || 8192 },
        }),
      });
      if (r.status === 403) throw new Error("Ollama refuse l'extension (403) : définir OLLAMA_ORIGINS, voir les options");
      if (!r.ok) throw new Error("Ollama HTTP " + r.status);
      return extractJson((await r.json()).message.content);
    }
    if (p === "openai") {
      const base = (cfg.apiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
      const r = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (cfg.apiKey || "none") },
        body: JSON.stringify({ model: cfg.apiModel, temperature: 0.3, messages: [{ role: "user", content: text }] }),
      });
      if (!r.ok) throw new Error("API HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      return extractJson((await r.json()).choices[0].message.content || "");
    }
    if (p === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.anthropicKey || "",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({ model: cfg.anthropicModel || "claude-haiku-5-5", max_tokens: 8192, messages: [{ role: "user", content: text }] }),
      });
      if (!r.ok) throw new Error("Claude HTTP " + r.status + " " + (await r.text()).slice(0, 200));
      const j = await r.json();
      return extractJson(j.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    }
    throw new Error("fournisseur inconnu: " + p);
  }

  // ── Relecture (petites corrections seulement) ──
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

  // ── Point d'entrée ──
  async function translateAll(texts, src, tgt, cfg, ctx = {}) {
    if (!texts.length) return [];
    const names = (ctx.terms || []).map((t) => t.src || "");
    const dec = texts.map((t) => decaps(t, names));
    const c = { ...ctx, lowercased: dec.some((t, i) => t !== texts[i]) };
    texts = dec;
    if (cfg.provider && cfg.provider !== "google") {
      try {
        let out = await llmJson(prompt(texts, src, tgt, c), cfg);
        if (out && typeof out.translations === "object" && !Array.isArray(out.translations)) out = out.translations;
        if (!out || typeof out !== "object") throw new Error("réponse LLM invalide");
        const missing = texts.map((_, i) => i).filter((i) => typeof out[String(i + 1)] !== "string");
        if (missing.length > texts.length / 2) throw new Error(`réponse LLM incomplète (${texts.length - missing.length}/${texts.length})`);
        const fb = missing.length ? await google(missing.map((i) => texts[i]), src, tgt) : [];
        let result = texts.map((_, i) => (missing.includes(i) ? fb[missing.indexOf(i)] : out[String(i + 1)]));
        if (cfg.review) result = await review(texts, result, tgt, cfg);
        return result;
      } catch (e) {
        console.warn(`[KomaTranslator] ${cfg.provider} a échoué, repli sur Google:`, e.message);
        self.KomaLastError = e.message;
      }
    }
    return google(texts, src, tgt);
  }

  self.KomaTranslate = { translateAll, llmJson, LANG_NAMES };
})();
