const test = require("node:test");
const assert = require("node:assert/strict");
const { S } = require("./setup");

// chrome.storage.local en mémoire
function fakeStorage(init) {
  const data = { ...init };
  globalThis.chrome = { storage: { local: {
    get: async (k) => (k == null ? { ...data } : typeof k === "string" ? (k in data ? { [k]: data[k] } : {}) : {}),
    set: async (o) => { Object.assign(data, o); },
    remove: async (k) => { delete data[k]; },
  } } };
  return data;
}
const serie = (key, extra = {}) => ({ key, wiki: "", summary: "", glossary: [], corrections: {}, history: [], ...extra });

test("listSeries: séries seulement, de la plus volumineuse à la plus petite, avec les compteurs", async () => {
  fakeStorage({
    cfg: { provider: "google" },
    "series:a.com/x": serie("a.com/x", { wiki: "https://w.org/x", summary: "s", glossary: [{ src: "A", tgt: "B" }, { src: "C", tgt: "D" }], corrections: { t: "u" }, history: [["a", "b"]] }),
    "series:b.com/y": serie("b.com/y"),
  });
  const list = await S.listSeries();
  assert.deepEqual(list.map((s) => s.key), ["a.com/x", "b.com/y"]);
  assert.deepEqual({ ...list[0], bytes: 0 }, { key: "a.com/x", wiki: "https://w.org/x", terms: 2, summary: true, corrections: 1, history: 1, bytes: 0 });
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
