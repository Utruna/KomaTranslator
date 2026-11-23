const $ = (id) => document.getElementById(id);

(async () => {
  // Firefox n'accorde pas l'accès aux sites d'office en Manifest V3: il faut le demander
  const ALL = { origins: ["<all_urls>"] };
  if (!(await chrome.permissions.contains(ALL))) {
    $("grant").hidden = false;
    $("grant").onclick = async () => {
      if (await chrome.permissions.request(ALL)) { $("grant").hidden = true; location.reload(); }
    };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab.url).hostname; } catch {}
  $("host").textContent = host;

  const s = await chrome.storage.sync.get(["sites", "src", "tgt"]);
  const sites = s.sites || {};
  $("enabled").checked = !!sites[host];
  $("src").value = s.src || "auto";
  $("tgt").value = s.tgt || "fr";

  $("enabled").onchange = async () => {
    const { sites = {} } = await chrome.storage.sync.get("sites");
    sites[host] = $("enabled").checked;
    await chrome.storage.sync.set({ sites });
  };
  $("src").onchange = () => chrome.storage.sync.set({ src: $("src").value });
  $("tgt").onchange = () => chrome.storage.sync.set({ tgt: $("tgt").value });

  const h = await chrome.runtime.sendMessage({ type: "health" });
  $("status").className = h?.ok ? "ok" : "ko";
  $("status").textContent = h?.ok
    ? `Serveur OK (traduction : ${h.provider})`
    : "Serveur éteint — lance start_server.bat";
})();
