const test = require("node:test");
const assert = require("node:assert/strict");
const { T } = require("./setup");

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; self.KomaLastError = ""; });

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
// Google: renvoie "TR:<texte>" ; échoue (500) pour les textes listés dans `failing`
const googleStub = (failing = []) => async (url) => {
  const q = decodeURIComponent(new URL(url).searchParams.get("q"));
  return failing.includes(q) ? json({}, 500) : json([[[`TR:${q}`, q]]]);
};
const llmReply = (content) => json({ choices: [{ message: { content } }] });
const LLM = { provider: "openai", apiBase: "http://llm.test", apiModel: "m", review: false };

test("fetchTimeout: abandonne après le délai", async () => {
  globalThis.fetch = (url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))));
  await assert.rejects(T.fetchTimeout("http://x", { timeout: 30, retries: 0 }), /délai dépassé/);
});

test("fetchTimeout: retryOnTimeout=false ne réattend pas un serveur qui ne répond pas", async () => {
  let calls = 0;
  globalThis.fetch = (url, { signal }) => new Promise((_, rej) => { calls++; signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))); });
  await assert.rejects(T.fetchTimeout("http://x", { timeout: 20, retries: 2, retryOnTimeout: false }), /délai dépassé/);
  assert.equal(calls, 1);
});

test("fetchTimeout: par défaut, un délai dépassé est retenté", async () => {
  let calls = 0;
  globalThis.fetch = (url, { signal }) => new Promise((res, rej) => {
    if (++calls === 1) signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" })));
    else res(json({}, 200));
  });
  assert.equal((await T.fetchTimeout("http://x", { timeout: 20, retries: 1 })).status, 200);
  assert.equal(calls, 2);
});

test("fetchTimeout: réessaie après un 503 puis réussit", async () => {
  let calls = 0;
  globalThis.fetch = async () => json({}, ++calls === 1 ? 503 : 200);
  const r = await T.fetchTimeout("http://x", { retries: 1 });
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
});

test("fetchTimeout: ne réessaie pas une erreur 404", async () => {
  let calls = 0;
  globalThis.fetch = async () => json({}, (calls++, 404));
  const r = await T.fetchTimeout("http://x", { retries: 2 });
  assert.equal(r.status, 404);
  assert.equal(calls, 1);
});

test("translateAll (Google): tout réussit → pas dégradé", async () => {
  globalThis.fetch = googleStub();
  const info = {};
  assert.deepEqual(await T.translateAll(["a", "b"], "en", "fr", { provider: "google" }, {}, info), ["TR:a", "TR:b"]);
  assert.equal(info.degraded, undefined);
});

test("translateAll (Google): une bulle échoue → gardée telle quelle et dégradé", async () => {
  globalThis.fetch = googleStub(["b"]);
  const info = {};
  assert.deepEqual(await T.translateAll(["a", "b"], "en", "fr", { provider: "google" }, {}, info), ["TR:a", "b"]);
  assert.equal(info.degraded, true);
});

test("translateAll (LLM): réponse complète → pas dégradé", async () => {
  globalThis.fetch = async () => llmReply('{"1": "un", "2": "deux"}');
  const info = {};
  assert.deepEqual(await T.translateAll(["a", "b"], "en", "fr", LLM, {}, info), ["un", "deux"]);
  assert.equal(info.degraded, undefined);
});

test("translateAll (LLM): une bulle manquante → complétée par Google, dégradé", async () => {
  globalThis.fetch = async (url) => (String(url).startsWith("http://llm.test") ? llmReply('{"1": "un", "2": "deux"}') : googleStub()(url));
  const info = {};
  assert.deepEqual(await T.translateAll(["a", "b", "c"], "en", "fr", LLM, {}, info), ["un", "deux", "TR:c"]);
  assert.equal(info.degraded, true);
});

test("translateAll (LLM): erreur HTTP → repli Google, dégradé, erreur mémorisée", async () => {
  globalThis.fetch = async (url) => (String(url).startsWith("http://llm.test") ? json({}, 401) : googleStub()(url));
  const info = {};
  assert.deepEqual(await T.translateAll(["a"], "en", "fr", LLM, {}, info), ["TR:a"]);
  assert.equal(info.degraded, true);
  assert.match(self.KomaLastError, /401/);
});

test("extractJson: tolère <think>, clôtures et texte autour", () => {
  const { extractJson } = T._internals;
  assert.deepEqual(extractJson('<think>hmm</think>```json\n{"1": "a"}\n```'), { 1: "a" });
  assert.deepEqual(extractJson('Voici : {"1": "a"} voilà'), { 1: "a" });
  assert.throws(() => extractJson("pas de json"), /non JSON/);
});

test("decaps: texte en majuscules → casse normale, noms du glossaire conservés", () => {
  const { decaps } = T._internals;
  assert.equal(decaps("I AM HERE. ZHAN XIAO!", ["Zhan Xiao"]), "I am here. Zhan Xiao!");
  assert.equal(decaps("Déjà en casse normale", []), "Déjà en casse normale");
  assert.equal(decaps("OK", []), "OK"); // trop court
});

test("similarity: 1 = identique, proche de 0 = différent", () => {
  const { similarity } = T._internals;
  assert.equal(similarity("Salut", "salut"), 1);
  assert.ok(similarity("Tu vas mourir", "Tu vas mourrir") > 0.9);
  assert.ok(similarity("abc", "xyz") < 0.1);
});
