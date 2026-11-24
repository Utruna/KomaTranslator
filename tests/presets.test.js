const test = require("node:test");
const assert = require("node:assert/strict");
globalThis.self = globalThis;
require("../extension/presets.js");
const P = self.KomaPresets;

test("activeId: déduit le traducteur de la cfg", () => {
  assert.equal(P.activeId({}), "google");
  assert.equal(P.activeId({ provider: "ollama" }), "ollama");
  assert.equal(P.activeId({ provider: "anthropic" }), "anthropic");
  assert.equal(P.activeId({ provider: "openai" }), "deepseek", "URL par défaut = DeepSeek");
  assert.equal(P.activeId({ provider: "openai", apiBase: P.PRESETS.gemini.apiBase }), "gemini");
  assert.equal(P.activeId({ provider: "openai", apiBase: "https://api.mistral.ai/v1" }), "custom");
});

test("isReady: Google et Ollama sans clé, les autres selon la clé", () => {
  assert.equal(P.isReady({}, "google"), true);
  assert.equal(P.isReady({}, "ollama"), true);
  assert.equal(P.isReady({}, "anthropic"), false);
  assert.equal(P.isReady({ anthropicKey: "k" }, "anthropic"), true);
  assert.equal(P.isReady({}, "deepseek"), false);
  assert.equal(P.isReady({ provider: "openai", apiKey: "sk" }, "deepseek"), true, "clé de la cfg active");
  assert.equal(P.isReady({ provider: "openai", apiKey: "sk" }, "gemini"), false, "pas la clé d'un autre préréglage");
  assert.equal(P.isReady({ provider: "google", profiles: { gemini: { apiKey: "g" } } }, "gemini"), true, "clé du profil");
});

test("select: change de traducteur sans perdre les clés des autres", () => {
  let cfg = { ...P.CFG_DEFAULTS, provider: "openai", apiKey: "sk-deepseek", apiModel: "deepseek-flash" };
  cfg = { ...cfg, profiles: { gemini: { apiKey: "AQ-gemini", apiModel: "gemini-3.5-flash-lite" } } };
  const g = P.select(cfg, "gemini");
  assert.equal(g.provider, "openai");
  assert.equal(g.apiBase, P.PRESETS.gemini.apiBase);
  assert.equal(g.apiKey, "AQ-gemini");
  assert.equal(g.profiles.deepseek.apiKey, "sk-deepseek", "la clé DeepSeek est mémorisée avant de changer");
  const back = P.select(g, "deepseek");
  assert.equal(back.apiKey, "sk-deepseek");
  assert.equal(back.apiBase, P.PRESETS.deepseek.apiBase);
  assert.equal(P.select(back, "google").provider, "google");
  assert.equal(P.select(back, "ollama").provider, "ollama");
  assert.equal(P.select(back, "google").profiles.deepseek.apiKey, "sk-deepseek", "les profils survivent à Google");
});

test("select: « Autre API » garde son URL", () => {
  const cfg = { ...P.CFG_DEFAULTS, provider: "openai", apiBase: "https://api.mistral.ai/v1", apiKey: "m", apiModel: "mistral-small" };
  const out = P.select(P.select(cfg, "google"), "custom");
  assert.equal(out.apiBase, "https://api.mistral.ai/v1");
  assert.equal(out.apiKey, "m");
  assert.equal(out.apiModel, "mistral-small");
});

test("modelOf / setModel", () => {
  const cfg = { ...P.CFG_DEFAULTS, provider: "openai", apiKey: "sk" };
  assert.equal(P.modelOf(cfg, "deepseek"), "deepseek-flash");
  assert.equal(P.modelOf(cfg, "gemini"), "gemini-3.5-flash-lite");
  assert.equal(P.modelOf(cfg, "google"), "");
  const c2 = P.setModel(cfg, "deepseek", "deepseek-v4-pro");
  assert.equal(c2.apiModel, "deepseek-v4-pro");
  assert.equal(P.modelOf(c2, "deepseek"), "deepseek-v4-pro");
  const c3 = P.setModel(cfg, "gemini", "gemini-3.1-flash-lite"); // pas actif: seulement le profil
  assert.equal(c3.apiModel, "deepseek-flash");
  assert.equal(P.modelOf(c3, "gemini"), "gemini-3.1-flash-lite");
  assert.equal(P.setModel(cfg, "ollama", "llama3").ollamaModel, "llama3");
  assert.equal(P.setModel(cfg, "anthropic", "claude-x").anthropicModel, "claude-x");
});

test("tarifs: DeepSeek (pointe / creuses), Gemini gratuit, Ollama local, inconnu → null, tarif saisi prioritaire", () => {
  const ds = { provider: "openai", apiBase: P.PRESETS.deepseek.apiBase };
  const lundi10h = new Date("2026-11-23T08:00:00Z"), dimanche = new Date("2026-11-22T08:00:00Z"), lundi12h = new Date("2026-11-23T12:00:00Z");
  assert.deepEqual([P.priceOf(ds, lundi10h).in, P.priceOf(ds, lundi10h).out], [0.3, 1.2], "heures de pointe");
  assert.deepEqual([P.priceOf(ds, dimanche).in, P.priceOf(ds, dimanche).out], [0.15, 0.6], "week-end");
  assert.equal(P.priceOf(ds, lundi12h).label, "heures creuses");
  assert.equal(P.priceOf({ provider: "openai", apiBase: P.PRESETS.gemini.apiBase }).out, 0);
  assert.equal(P.priceOf({ provider: "ollama" }).label, "local");
  assert.equal(P.priceOf({ provider: "google" }), null);
  assert.equal(P.priceOf({ provider: "anthropic" }), null, "Claude: tarif non connu");
  assert.deepEqual(P.priceOf({ provider: "anthropic", priceIn: "1", priceOut: "5" }), { in: 1, out: 5, label: "tarif saisi" });
  assert.equal(P.priceOf({ ...ds, priceIn: 2, priceOut: 4 }).in, 2, "le tarif saisi l'emporte");
  assert.ok(Math.abs(P.costOf(ds, 1_000_000, 1_000_000, dimanche) - 0.75) < 1e-12);
  assert.equal(P.costOf({ provider: "anthropic" }, 10, 10), null);
});

test("parseBalance: réponse de GET /user/balance de DeepSeek", () => {
  const r = P.parseBalance({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.52", granted_balance: "0.00", topped_up_balance: "4.52" }, { currency: "CNY", total_balance: "110.00" }] });
  assert.deepEqual(r, { available: true, balances: [{ currency: "USD", total: 4.52 }, { currency: "CNY", total: 110 }] });
  assert.deepEqual(P.parseBalance({ is_available: false, balance_infos: [] }), { available: false, balances: [] });
  assert.deepEqual(P.parseBalance(null), { available: false, balances: [] });
});
