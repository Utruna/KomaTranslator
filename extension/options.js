const $ = (id) => document.getElementById(id);
const FIELDS = ["ollamaUrl", "ollamaModel", "apiBase", "apiKey", "apiModel", "anthropicKey", "anthropicModel"];

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
  showPanels();
})();

document.querySelectorAll("input[name=provider]").forEach((r) => (r.onchange = showPanels));

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
