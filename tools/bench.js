#!/usr/bin/env node
// Compare les traducteurs de KomaTranslator sur de vraies bulles (tests/fixtures/bench-bulles.json).
// Mesure le temps, les requêtes, les jetons, le respect du glossaire, et affiche les traductions côte à côte.
//
//   node tools/bench.js [--out resultats.md]
//
// Les traducteurs testés dépendent des variables d'environnement (aucune clé n'est lue ni écrite ailleurs):
//   Google          toujours
//   GEMINI_API_KEY  [GEMINI_MODEL=gemini-3.5-flash-lite]
//   DEEPSEEK_API_KEY [DEEPSEEK_MODEL=deepseek-flash]
//   OLLAMA_URL      [OLLAMA_MODEL=qwen3.5:latest]   (ex. http://localhost:11434, à lancer sur la machine qui a le GPU)
//   ANTHROPIC_API_KEY [CLAUDE_MODEL=claude-haiku-5-5]
//   REVIEW=0        pour désactiver la relecture (une seule requête par page)
globalThis.self = globalThis;
require("../extension/lib/translate.js");
const fs = require("fs");
const path = require("path");
const T = self.KomaTranslate;
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "../tests/fixtures/bench-bulles.json"), "utf8"));
const env = process.env;
const review = env.REVIEW !== "0";

// ── Traducteurs ──
const providers = [{ name: "Google", cfg: { provider: "google" }, llm: false }];
if (env.GEMINI_API_KEY) {
  const m = env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  providers.push({ name: `Gemini ${m}`, llm: true, cfg: { provider: "openai", apiBase: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: env.GEMINI_API_KEY, apiModel: m } });
}
if (env.DEEPSEEK_API_KEY) {
  const m = env.DEEPSEEK_MODEL || "deepseek-flash";
  providers.push({ name: `DeepSeek ${m}`, llm: true, price: deepseekPrice, cfg: { provider: "openai", apiBase: "https://api.deepseek.com/v1", apiKey: env.DEEPSEEK_API_KEY, apiModel: m } });
}
if (env.OLLAMA_URL) {
  const m = env.OLLAMA_MODEL || "qwen3.5:latest";
  providers.push({ name: `Ollama ${m}`, llm: true, cfg: { provider: "ollama", ollamaUrl: env.OLLAMA_URL, ollamaModel: m } });
}
if (env.ANTHROPIC_API_KEY) {
  const m = env.CLAUDE_MODEL || "claude-haiku-5-5";
  providers.push({ name: `Claude ${m}`, llm: true, cfg: { provider: "anthropic", anthropicKey: env.ANTHROPIC_API_KEY, anthropicModel: m } });
}

/** Tarif DeepSeek V4.1 Flash (page officielle, relevé le 2026-11-24): dollars par million de jetons, hors cache. */
function deepseekPrice(now = new Date()) {
  const h = now.getUTCHours(), d = now.getUTCDay();
  const peak = d >= 1 && d <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10)); // jours fériés chinois ignorés
  return { in: peak ? 0.3 : 0.15, out: peak ? 1.2 : 0.6, label: peak ? "heures de pointe" : "heures creuses" };
}

// ── Mesure des requêtes: temps, nombre, jetons (champ « usage » des réponses) ──
const realFetch = globalThis.fetch;
let stats;
globalThis.fetch = async (url, opts) => {
  const t = Date.now();
  const r = await realFetch(url, opts);
  stats.req++; stats.ms += Date.now() - t;
  if (r.ok) {
    try {
      const j = await r.clone().json();
      const u = j.usage || {};
      stats.tin += u.prompt_tokens ?? u.input_tokens ?? j.prompt_eval_count ?? 0;
      stats.tout += u.completion_tokens ?? u.output_tokens ?? j.eval_count ?? 0;
    } catch { /* corps non JSON */ }
  }
  return r;
};

/** Bulles où un terme du glossaire apparaît dans la source: combien ont la forme imposée dans la traduction ? */
function glossaryScore(texts, out, terms) {
  let total = 0, ok = 0;
  texts.forEach((t, i) => terms.forEach((g) => {
    if (!T._internals.mentions(t, g)) return;
    total++;
    if (out[i].toLowerCase().includes(g.tgt.toLowerCase())) ok++;
  }));
  return { ok, total };
}

async function run(p, withContext) {
  stats = { req: 0, ms: 0, tin: 0, tout: 0 };
  T.setLastError("");
  const info = {};
  const t0 = Date.now();
  const cfg = { ...p.cfg, review: p.llm && review };
  const out = await T.translateAll(fx.texts, fx.src, fx.tgt, cfg, withContext ? fx.context : {}, info);
  const ms = Date.now() - t0;
  const same = out.filter((o, i) => o.trim().toLowerCase() === fx.texts[i].trim().toLowerCase()).length;
  return { name: p.name + (p.llm ? (withContext ? " · avec contexte" : " · sans contexte") : ""), out, ms, ...stats, degraded: !!info.degraded, error: self.KomaLastError || "", same,
    glossary: glossaryScore(fx.texts, out, fx.context.terms), cost: p.price && p.price() ? (stats.tin * p.price().in + stats.tout * p.price().out) / 1e6 : null, priceLabel: p.price && p.price().label };
}

(async () => {
  const results = [];
  for (const p of providers) {
    for (const withContext of p.llm ? [true, false] : [false]) {
      process.stderr.write(`→ ${p.name}${p.llm ? (withContext ? " (avec contexte)" : " (sans contexte)") : ""}…\n`);
      try { results.push(await run(p, withContext)); } catch (e) { results.push({ name: p.name, out: [], ms: 0, req: 0, tin: 0, tout: 0, degraded: true, error: String(e.message || e), same: 0, glossary: { ok: 0, total: 0 }, cost: null }); }
    }
  }
  const lines = [];
  lines.push(`# Bench KomaTranslator — ${new Date().toISOString().slice(0, 16)} UTC`, "",
    `${fx.texts.length} bulles réelles (anglais → français), relecture ${review ? "activée" : "désactivée"}. Une seule exécution par ligne: les temps varient d'un essai à l'autre.`, "",
    "| Traducteur | Temps | Requêtes | Jetons (entrée / sortie) | Glossaire respecté | Non traduites | État |", "|---|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    const gl = r.glossary.total ? `${r.glossary.ok}/${r.glossary.total}` : "—";
    const etat = r.error ? `échec: ${r.error.slice(0, 60)}` : r.degraded ? "dégradé" : "ok";
    lines.push(`| ${r.name} | ${(r.ms / 1000).toFixed(1)} s | ${r.req} | ${r.tin || "—"} / ${r.tout || "—"} | ${gl} | ${r.same} | ${etat} |`);
  }
  const priced = results.filter((r) => r.cost != null);
  if (priced.length) {
    lines.push("", "**Coût estimé** (tarif officiel DeepSeek V4.1 Flash, hors cache, " + priced[0].priceLabel + "): " +
      priced.map((r) => `${r.name}: $${r.cost.toFixed(5)} pour cette page, soit ≈ $${(r.cost * 30).toFixed(3)} pour un chapitre de 30 pages comparables`).join(" ; ") + ".");
  }
  lines.push("", "## Traductions", "");
  fx.texts.forEach((t, i) => {
    lines.push(`**${i + 1}. ${t}**`, "");
    for (const r of results) if (r.out[i] != null) lines.push(`- *${r.name}*: ${r.out[i]}`);
    lines.push("");
  });
  const md = lines.join("\n");
  console.log(md);
  const o = process.argv.indexOf("--out");
  if (o > 0) fs.writeFileSync(process.argv[o + 1], md + "\n");
})();
