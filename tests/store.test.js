const test = require("node:test");
const assert = require("node:assert/strict");
const { S } = require("./setup");

test("seriesKey: coupe au premier segment « chapitre »", () => {
  assert.equal(S.seriesKey("https://site.com/manga/ma-serie/chapitre-12"), "site.com/manga/ma-serie");
  assert.equal(S.seriesKey("https://site.com/series/solo/ch-3/"), "site.com/series/solo");
  assert.equal(S.seriesKey("https://site.com/ma-serie/42"), "site.com/ma-serie");
  assert.equal(S.seriesKey("https://site.com/"), "site.com");
  assert.equal(S.seriesKey("pas une url"), "inconnu");
  assert.equal(S.seriesKey(""), "inconnu");
});

test("acquire: une image à la fois par série, la plus haute dans la page d'abord", async () => {
  const order = [];
  const run = async (name, pos) => { const release = await S.acquire("s", pos); order.push(name); await new Promise((r) => setTimeout(r, 5)); release(); };
  // « premiere » prend le verrou tout de suite ; les trois autres attendent et doivent passer par position croissante
  await Promise.all([run("premiere", 0), run("c", 3000), run("a", 1000), run("b", 2000)]);
  assert.deepEqual(order, ["premiere", "a", "b", "c"]);
});

test("acquire: des séries différentes ne s'attendent pas", async () => {
  const r1 = await S.acquire("x", 0);
  const r2 = await Promise.race([S.acquire("y", 0), new Promise((r) => setTimeout(() => r("bloqué"), 50))]);
  assert.equal(typeof r2, "function");
  r1(); r2();
});

test("acquire: le verrou est libéré quand plus personne n'attend", async () => {
  (await S.acquire("z", 0))();
  const r = await Promise.race([S.acquire("z", 0), new Promise((res) => setTimeout(() => res("bloqué"), 50))]);
  assert.equal(typeof r, "function");
  r();
});

test("seriesSig: change avec le glossaire ou le résumé, pas avec l'historique", async () => {
  const base = { summary: "s", glossary: [{ src: "A", tgt: "B" }], history: [["x", "y"]] };
  const sig = await S.seriesSig(base);
  assert.match(sig, /^[0-9a-f]{8}$/);
  assert.equal(await S.seriesSig({ ...base, history: [["autre", "chose"]] }), sig);
  assert.notEqual(await S.seriesSig({ ...base, glossary: [{ src: "A", tgt: "C" }] }), sig);
  assert.notEqual(await S.seriesSig({ ...base, summary: "autre" }), sig);
});

test("bestCorrection: exacte, à la ponctuation près, ou proche pour les textes longs", () => {
  const c = {
    "I DIDN'T EXPECT THAT IT COULD BE REASSEMBLED": "Je ne pensais pas qu'il pouvait se reconstituer",
    "WAIT!": "Attends !",
    "Zhan Xiao": "Zhan Xiao",
  };
  assert.equal(S.bestCorrection(c, "WAIT!"), "Attends !");
  assert.equal(S.bestCorrection(c, "wait"), "Attends !", "casse et ponctuation");
  assert.match(S.bestCorrection(c, "I DIDN'T EXPECT THAT IT COULD BE REASSEMBLEO"), /reconstituer/, "une lettre lue de travers");
  assert.equal(S.bestCorrection(c, "WAIT, WHAT?"), undefined, "texte différent");
  assert.equal(S.bestCorrection(c, "Zhan Xian"), undefined, "texte court: pas d'approximation");
  assert.equal(S.bestCorrection(c, "THE SKY IS BLUE TODAY AND BIRDS SING"), undefined);
  assert.equal(S.bestCorrection(c, "!!!"), undefined);
});
