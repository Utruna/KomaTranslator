const test = require("node:test");
const assert = require("node:assert/strict");
const { S } = require("./setup");

const { fakeStorage } = require("./helpers");
const serie = (key, extra = {}) => ({ key, wiki: "", summary: "", glossary: [], corrections: {}, history: [], ...extra });

test("listSeries: séries seulement, de la plus volumineuse à la plus petite, avec les compteurs", async () => {
  fakeStorage({
    cfg: { provider: "google" },
    "series:a.com/x": serie("a.com/x", { wiki: "https://w.org/x", summary: "s", glossary: [{ src: "A", tgt: "B" }, { src: "C", tgt: "D" }], corrections: { t: "u" }, history: [["a", "b"]] }),
    "series:b.com/y": serie("b.com/y"),
  });
  const list = await S.listSeries();
  assert.deepEqual(list.map((s) => s.key), ["a.com/x", "b.com/y"]);
  assert.deepEqual({ ...list[0], bytes: 0 }, { key: "a.com/x", wiki: "https://w.org/x", terms: 2, summary: true, corrections: 1, history: 1, langs: ["fr"], bytes: 0 });
  assert.ok(list[0].bytes > list[1].bytes);
});

test("clearPart: « wiki » retire URL, résumé et glossaire mais garde corrections et historique", async () => {
  const data = fakeStorage({ "series:a.com/x": serie("a.com/x", { wiki: "https://w.org", summary: "s", glossary: [{ src: "A", tgt: "B" }], corrections: { t: "u" }, history: [["a", "b"]] }) });
  await S.clearPart("a.com/x", "wiki");
  const d = data["series:a.com/x"];
  assert.deepEqual([d.wiki, d.summary, d.glossary.length], ["", "", 0]);
  assert.deepEqual(d.corrections, { t: "u" });
  assert.equal(d.history.length, 1);
});

test("clearPart: corrections, historique, partie inconnue", async () => {
  const data = fakeStorage({ "series:a.com/x": serie("a.com/x", { corrections: { t: "u" }, history: [["a", "b"]], glossary: [{ src: "A", tgt: "B" }] }) });
  await S.clearPart("a.com/x", "corrections");
  assert.deepEqual(data["series:a.com/x"].corrections, {});
  await S.clearPart("a.com/x", "history");
  assert.deepEqual(data["series:a.com/x"].history, []);
  assert.equal(data["series:a.com/x"].glossary.length, 1, "le glossaire n'est pas touché");
  await assert.rejects(S.clearPart("a.com/x", "tout"), /inconnue/);
});

test("deleteSeries: supprime la série et seulement celle-là", async () => {
  const data = fakeStorage({ "series:a.com/x": serie("a.com/x"), "series:b.com/y": serie("b.com/y"), cfg: {} });
  await S.deleteSeries("a.com/x");
  assert.deepEqual(Object.keys(data).sort(), ["cfg", "series:b.com/y"]);
});

test("cacheCount: 0 quand IndexedDB est indisponible", async () => {
  assert.equal(await S.cacheCount(), 0);
});

test("sanitizeSeries: refuse sans clé, borne les tailles, ne garde que les champs connus", () => {
  assert.equal(S.sanitizeSeries(null), null);
  assert.equal(S.sanitizeSeries({ glossary: [] }), null);
  assert.equal(S.sanitizeSeries({ key: "  " }), null);
  const c = S.sanitizeSeries({ key: "a.com/x", evil: "x", summary: "s".repeat(9000), glossary: [{ src: "A", tgt: "B", extra: 1 }, { src: "", tgt: "x" }, null], corrections: { "": "x", t: "u", v: "" }, history: [["a", "b"], "nope"] });
  assert.deepEqual(Object.keys(c).sort(), ["corrections", "glossary", "history", "key", "lang", "summary", "wiki"]);
  assert.equal(c.summary.length, 5000);
  assert.deepEqual(c.glossary, [{ src: "A", orig: "", tgt: "B", type: "", note: "" }]);
  assert.deepEqual(c.corrections, { t: "u" });
  assert.deepEqual(c.history, [["a", "b"]]);
});

test("exportSeries: toutes les séries ou celles demandées, sans l'historique", async () => {
  fakeStorage({ "series:a.com/x": serie("a.com/x", { glossary: [{ src: "A", tgt: "B" }], history: [["a", "b"]] }), "series:b.com/y": serie("b.com/y"), cfg: { apiKey: "secret" } });
  const all = await S.exportSeries();
  assert.equal(all.app, "KomaTranslator");
  assert.deepEqual(all.series.map((s) => s.key).sort(), ["a.com/x", "b.com/y"]);
  assert.equal("history" in all.series[0], false);
  assert.equal(JSON.stringify(all).includes("secret"), false, "la config et les clés API ne sont jamais exportées");
  assert.deepEqual((await S.exportSeries(["b.com/y"])).series.map((s) => s.key), ["b.com/y"]);
});

test("importSeries: série nouvelle ajoutée; existante fusionnée (glossaire importé gagne, corrections locales gagnent)", async () => {
  const data = fakeStorage({ "series:a.com/x": serie("a.com/x", { summary: "mien", glossary: [{ src: "Xiao Yan", orig: "", tgt: "ancien", type: "", note: "" }], corrections: { t: "ma version" } }) });
  const file = { app: "KomaTranslator", version: 1, series: [
    { key: "a.com/x", summary: "importé", wiki: "https://w.org", glossary: [{ src: "xiao yan", tgt: "Xiao Yan" }, { src: "Nouveau", tgt: "Neuf" }], corrections: { t: "version importée", u: "v" } },
    { key: "n.com/z", glossary: [{ src: "A", tgt: "B" }] },
    { nokey: true },
  ] };
  assert.deepEqual(await S.importSeries(file), { added: 1, merged: 1, skipped: 1 });
  const d = data["series:a.com/x"];
  assert.equal(d.summary, "mien", "le résumé existant est gardé");
  assert.equal(d.wiki, "https://w.org", "le wiki manquant est repris");
  assert.deepEqual(d.glossary.map((t) => t.tgt).sort(), ["Neuf", "Xiao Yan"], "même terme source (sans casse): l'importé gagne");
  assert.deepEqual(d.corrections, { t: "ma version", u: "v" });
  assert.ok(data["series:n.com/z"]);
  await assert.rejects(S.importSeries({ app: "autre" }), /export KomaTranslator/);
  await assert.rejects(S.importSeries(null), /export KomaTranslator/);
});

test("putSeries: restaure une série supprimée telle quelle", async () => {
  const data = fakeStorage({});
  await S.putSeries(serie("a.com/x", { summary: "s", corrections: { a: "b" } }));
  assert.equal(data["series:a.com/x"].corrections.a, "b");
  await assert.rejects(S.putSeries({ summary: "sans clé" }), /invalide/);
});

test("consommation: cumul par jour et traducteur, coût du jour, résumé du mois, purge", async () => {
  fakeStorage({});
  const d1 = new Date("2026-11-24T10:00:00Z"), d2 = new Date("2026-11-25T10:00:00Z");
  await Promise.all([
    S.usageAdd("deepseek", { req: 1, tin: 1000, tout: 200, cost: 0.001 }, d1),
    S.usageAdd("deepseek", { req: 1, tin: 500, tout: 100, pages: 1, cost: 0.0005 }, d1), // en parallèle: aucune perte
    S.usageAdd("gemini", { req: 1, tin: 300, tout: 50, cost: 0 }, d1),
    S.usageAdd("anthropic", { req: 1, tin: 10, tout: 5, cost: null }, d1), // tarif inconnu
    S.usageAdd("deepseek", { req: 1, tin: 100, tout: 10, cost: 0.0001 }, d2),
  ]);
  assert.ok(Math.abs((await S.usageCostToday(d1)) - 0.0015) < 1e-9);
  const sum = await S.usageSummary(d1);
  assert.deepEqual({ req: sum.today.deepseek.req, tin: sum.today.deepseek.tin, pages: sum.today.deepseek.pages }, { req: 2, tin: 1500, pages: 1 });
  assert.equal(sum.today.anthropic.cost, 0, "tarif inconnu: pas de coût compté");
  assert.equal(sum.month.deepseek.req, 3);
  assert.deepEqual(sum.days.map((x) => x.day), ["2026-11-25", "2026-11-24"], "jours récents d'abord");
  // purge au-delà de 62 jours
  for (let i = 0; i < 70; i++) await S.usageAdd("deepseek", { req: 1 }, new Date(Date.UTC(2026, 0, 1 + i)));
  assert.ok((await S.usageSummary(d1)).days.length <= 62);
});

test("autre langue cible: pas d'exemples ni de rendus ni de corrections dans l'ancienne langue", async () => {
  fakeStorage({ "series:a.com/x": serie("a.com/x", {
    glossary: [{ src: "Sugimoto", orig: "杉元", tgt: "Sugimoto", type: "character" }, { src: "Sect", tgt: "Secte" }],
    corrections: { "おい": "Hé !" },
    history: [["a", "en français"], ["b", "in english", "en"], ["c", "encore en français", "fr"]],
  }) });
  const fr = await S.contextFor("a.com/x", ["杉元"], "fr");
  assert.deepEqual(fr.history, [["a", "en français"], ["c", "encore en français"]]); // ancienne entrée sans langue = fr
  assert.equal(fr.terms.find((t) => t.src === "Sect").tgt, "Secte");
  assert.deepEqual(fr.corrections, { "おい": "Hé !" });
  const en = await S.contextFor("a.com/x", ["杉元"], "en");
  assert.deepEqual(en.history, [["b", "in english"]]);
  assert.ok(en.terms.every((t) => t.tgt === ""), "les noms restent, sans rendu français");
  assert.deepEqual(en.corrections, {});
  assert.deepEqual(await S.correctionsFor("a.com/x", "en"), {});
  assert.deepEqual(await S.correctionsFor("a.com/x", "fr"), { "おい": "Hé !" });
});

test("listSeries: langues présentes dans chaque série (étiquettes et filtre de l'écran Mémoire)", async () => {
  fakeStorage({
    "series:a.com/x": serie("a.com/x", { glossary: [{ src: "A", tgt: "B" }], history: [["a", "b"], ["c", "d", "en"]] }),
    "series:b.com/y": serie("b.com/y", { lang: "en", corrections: { t: "u" } }),
    "series:c.com/z": serie("c.com/z"),
  });
  const langs = Object.fromEntries((await S.listSeries()).map((s) => [s.key, s.langs]));
  assert.deepEqual(langs, { "a.com/x": ["en", "fr"], "b.com/y": ["en"], "c.com/z": [] });
});
