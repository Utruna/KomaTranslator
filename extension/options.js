const $ = (id) => document.getElementById(id);
const FIELDS = ["ollamaUrl", "ollamaModel", "apiBase", "apiKey", "apiModel", "anthropicKey", "anthropicModel"];

// Préréglages du fournisseur « API compatible OpenAI »: remplissent l'URL et le modèle.
const PRESETS = {
  gemini: {
    apiBase: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiModel: "gemini-3.5-flash-lite",
    note: "Clé gratuite sur aistudio.google.com/apikey. Le palier gratuit est limité en requêtes par minute et par jour (voir ton compte), "
      + "et Google peut y réutiliser les textes envoyés pour améliorer ses produits : à vérifier dans leurs conditions. "
      + "Les modèles changent vite : si le test répond 404, prends un autre « gemini-…-flash-lite ».",
  },
  deepseek: { apiBase: "https://api.deepseek.com/v1", apiModel: "deepseek-chat", note: "Clé payante (quelques centimes par chapitre), sur platform.deepseek.com." },
};
const presetFor = (base) => Object.keys(PRESETS).find((k) => PRESETS[k].apiBase === base) || "";
function showPreset() {
  $("presetNote").textContent = PRESETS[$("preset").value]?.note || "";
}

function showPanels() {
  const p = document.querySelector("input[name=provider]:checked")?.value || "google";
  document.querySelectorAll(".panel[data-for]").forEach((el) => el.classList.toggle("show", el.dataset.for === p));
  document.querySelector(".panel.llm").classList.toggle("show", p !== "google");
}

function readForm() {
  const cfg = { provider: document.querySelector("input[name=provider]:checked")?.value || "google", review: $("review").checked };
  for (const f of FIELDS) cfg[f] = $(f).value.trim();
  return cfg;
}

(async () => {
  const { cfg = {} } = await chrome.storage.local.get("cfg");
  const provider = cfg.provider || "google";
  document.querySelector(`input[name=provider][value=${provider}]`).checked = true;
  for (const f of FIELDS) if (cfg[f]) $(f).value = cfg[f];
  $("review").checked = cfg.review !== false; // activée par défaut
  const st = await chrome.storage.sync.get(["font", "caps"]);
  $("font").value = st.font || "";
  $("caps").checked = !!st.caps;
  $("preset").value = presetFor($("apiBase").value.trim());
  showPreset();
  showPanels();
})();

document.querySelectorAll("input[name=provider]").forEach((r) => (r.onchange = showPanels));

$("caps").onchange = () => chrome.storage.sync.set({ caps: $("caps").checked });
$("font").onchange = () => chrome.storage.sync.set({ font: $("font").value.trim() });

$("preset").onchange = () => {
  const p = PRESETS[$("preset").value];
  if (p) { $("apiBase").value = p.apiBase; $("apiModel").value = p.apiModel; }
  showPreset();
};
$("apiBase").oninput = () => { $("preset").value = presetFor($("apiBase").value.trim()); showPreset(); };

$("save").onclick = async () => {
  const cfg = readForm();
  // champs vides = valeurs par défaut
  for (const f of FIELDS) if (!cfg[f]) delete cfg[f];
  await chrome.storage.local.set({ cfg });
  $("result").className = "";
  $("result").textContent = "Enregistré, test en cours…";
  const r = await chrome.runtime.sendMessage({ type: "testProvider", cfg });
  if (r?.ok) {
    $("result").className = "ok";
    $("result").textContent = `✔ « ${r.result} » (${r.ms} ms)`;
  } else {
    $("result").className = "ko";
    $("result").textContent = "✘ " + (r?.error || "pas de réponse");
  }
};

$("clearCache").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: "retranslate", tabId: tab?.id ?? -1 }).catch(() => {});
  $("cacheMsg").textContent = "Cache vidé.";
};
