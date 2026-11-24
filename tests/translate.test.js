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

// LLM simulé: répond selon les bulles numérotées de la requête (après « ITEMS: »); compte les appels
const llmStub = (answer, { google = googleStub() } = {}) => {
  const calls = [];
  const f = async (url, opts) => {
    if (!String(url).startsWith("http://llm.test")) return google(url);
    const content = JSON.parse(opts.body).messages[0].content;
    const items = JSON.parse(content.split("ITEMS:\n")[1]);
    calls.push({ content, items, body: JSON.parse(opts.body) });
    return llmReply(JSON.stringify(answer(items, calls.length)));
  };
  f.calls = calls;
  return f;
};

test("translateAll (LLM): une bulle manquante est redemandée au LLM, sans repli Google", async () => {
  const stub = llmStub((items, n) => (n === 1 ? { 1: "un", 2: "deux" } : { 1: "trois" }));
  globalThis.fetch = stub;
  const info = {};
  assert.deepEqual(await T.translateAll(["a", "b", "c"], "en", "fr", LLM, {}, info), ["un", "deux", "trois"]);
  assert.equal(info.degraded, undefined);
  assert.equal(stub.calls.length, 2);
  assert.deepEqual(stub.calls[1].items, { 1: "c" }, "la relance ne contient que la bulle manquante");
});

test("translateAll (LLM): toujours manquante après la relance → Google, dégradé", async () => {
  globalThis.fetch = llmStub((items) => (Object.keys(items).length === 3 ? { 1: "un", 2: "deux" } : {}));
  const info = {};
  assert.deepEqual(await T.translateAll(["a", "b", "c"], "en", "fr", LLM, {}, info), ["un", "deux", "TR:c"]);
  assert.equal(info.degraded, true);
});

test("Google: au plus 3 requêtes simultanées", async () => {
  let now = 0, max = 0;
  globalThis.fetch = async (url) => {
    now++; max = Math.max(max, now);
    await new Promise((r) => setTimeout(r, 10));
    now--;
    return googleStub()(url);
  };
  const out = await T.translateAll(Array.from({ length: 10 }, (_, i) => "t" + i), "en", "fr", { provider: "google" });
  assert.equal(out.length, 10);
  assert.ok(max <= 3 && max >= 2, `max simultané = ${max}`);
});

test("température 0 pour les trois fournisseurs; keep_alive d'Ollama réglable", async () => {
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    bodies.push([String(url), JSON.parse(opts.body)]);
    if (String(url).includes("/api/chat")) return json({ message: { content: '{"1":"x"}' } });
    if (String(url).includes("anthropic")) return json({ content: [{ type: "text", text: '{"1":"x"}' }] });
    return llmReply('{"1":"x"}');
  };
  await T.translateAll(["a"], "en", "fr", { provider: "ollama", ollamaUrl: "http://o.test", review: false });
  await T.translateAll(["a"], "en", "fr", { provider: "ollama", ollamaUrl: "http://o.test", ollamaKeepAlive: "30s", review: false });
  await T.translateAll(["a"], "en", "fr", { provider: "ollama", ollamaUrl: "http://o.test", ollamaKeepAlive: "-1", review: false });
  await T.translateAll(["a"], "en", "fr", LLM);
  await T.translateAll(["a"], "en", "fr", { provider: "anthropic", anthropicKey: "k", review: false });
  const [o1, o2, o3, oai, ant] = bodies.map(([, b]) => b);
  assert.equal(o1.options.temperature, 0);
  assert.equal(o1.keep_alive, "5m", "défaut: 5 minutes (et non 30)");
  assert.equal(o2.keep_alive, "30s");
  assert.strictEqual(o3.keep_alive, -1, "un nombre est envoyé comme nombre");
  assert.equal(oai.temperature, 0);
  assert.equal(ant.temperature, 0);
});

test("glossaire: un terme non appliqué est corrigé par une relance ciblée", async () => {
  const ctx = { terms: [{ src: "Sword Sect", orig: "", tgt: "Secte de l'Épée", type: "organization" }], summary: "s" };
  const stub = llmStub((items, n) => (n === 1 ? { 1: "La secte d'épée attaque." } : { 1: "La Secte de l'Épée attaque." }));
  globalThis.fetch = stub;
  const out = await T.translateAll(["The Sword Sect attacks."], "en", "fr", LLM, ctx);
  assert.deepEqual(out, ["La Secte de l'Épée attaque."]);
  assert.equal(stub.calls.length, 2);
  assert.match(stub.calls[1].content, /MANDATORY/);
  assert.match(stub.calls[1].content, /Secte de l'Épée/);
});

test("glossaire: déjà appliqué ou terme absent → pas de relance", async () => {
  const ctx = { terms: [{ src: "Sword Sect", tgt: "Secte de l'Épée" }] };
  let stub = llmStub(() => ({ 1: "La Secte de l'Épée attaque." }));
  globalThis.fetch = stub;
  await T.translateAll(["The Sword Sect attacks."], "en", "fr", LLM, ctx);
  assert.equal(stub.calls.length, 1);
  stub = llmStub(() => ({ 1: "Il pleut." }));
  globalThis.fetch = stub;
  await T.translateAll(["It rains."], "en", "fr", LLM, ctx);
  assert.equal(stub.calls.length, 1);
});

test("glossaire: les termes très courts sont ignorés", () => {
  const { mentions } = T._internals;
  assert.equal(mentions("A quiet day", { src: "Qi" }), false);
  assert.equal(mentions("Qi is power", { src: "Qi" }), false);
  assert.equal(mentions("萧炎来了", { orig: "萧炎" }), true);
  assert.equal(mentions("Xiao Yan came", { src: "Xiao Yan" }), true);
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
