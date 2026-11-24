const $ = (id) => document.getElementById(id);
const FIELDS = ["ollamaUrl", "ollamaModel", "ollamaKeepAlive", "apiBase", "apiKey", "apiModel", "anthropicKey", "anthropicModel"];

// Préréglages du fournisseur « API compatible OpenAI » (voir presets.js): remplissent l'URL, le modèle et la clé mémorisée.
const { PRESETS } = KomaPresets;
const presetFor = (base) => { const k = KomaPresets.presetOfBase(base); return PRESETS[k] ? k : ""; };
let profiles = {};   // { deepseek: { apiKey, apiModel }, … } (cfg.profiles)
let shownPreset = ""; // préréglage actuellement affiché dans le formulaire

/** Range les champs « API » du formulaire dans le profil du préréglage affiché. */
function stashProfile() {
  if (shownPreset) profiles[shownPreset] = { apiKey: $("apiKey").value.trim(), apiModel: $("apiModel").value.trim() || PRESETS[shownPreset].apiModel };
}
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
  profiles = { ...(cfg.profiles || {}) };
  shownPreset = presetFor($("apiBase").value.trim());
  $("preset").value = shownPreset;
  showPreset();
  showPanels();
})();

document.querySelectorAll("input[name=provider]").forEach((r) => (r.onchange = showPanels));

$("caps").onchange = () => chrome.storage.sync.set({ caps: $("caps").checked });
$("font").onchange = () => chrome.storage.sync.set({ font: $("font").value.trim() });

$("preset").onchange = () => {
  stashProfile(); // on ne perd pas la clé du préréglage qu'on quitte
  shownPreset = $("preset").value;
  const p = PRESETS[shownPreset];
  if (p) {
    $("apiBase").value = p.apiBase;
    $("apiModel").value = profiles[shownPreset]?.apiModel || p.apiModel;
    $("apiKey").value = profiles[shownPreset]?.apiKey || "";
  }
  showPreset();
};
$("apiBase").oninput = () => { stashProfile(); shownPreset = presetFor($("apiBase").value.trim()); $("preset").value = shownPreset; showPreset(); };

$("save").onclick = async () => {
  let cfg = readForm();
  // champs vides = valeurs par défaut
  for (const f of FIELDS) if (!cfg[f]) delete cfg[f];
  stashProfile();
  cfg.profiles = profiles;
  cfg = KomaPresets.remember(cfg); // aussi pour « Autre API »
  profiles = cfg.profiles;
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

$("unloadOllama").onclick = async () => {
  $("unloadMsg").textContent = "…";
  const r = await chrome.runtime.sendMessage({ type: "unloadOllama", cfg: readForm() });
  $("unloadMsg").textContent = r?.ok ? "Modèle déchargé." : "✘ " + (r?.error || "pas de réponse");
};

$("clearCache").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.runtime.sendMessage({ type: "retranslate", tabId: tab?.id ?? -1 }).catch(() => {});
  $("cacheMsg").textContent = "Cache vidé.";
};
