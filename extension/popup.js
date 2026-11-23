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

  // ── Série: glossaire / wiki ──
  const showSeries = (j) => {
    $("skey").textContent = j.key || "";
    $("sinfo").textContent = j.terms ? `${j.terms} termes dans le glossaire` : "Pas encore de glossaire";
    $("sinfo").title = j.summary || "";
    if (j.wiki && !$("wiki").value) $("wiki").value = j.wiki;
  };
  chrome.runtime.sendMessage({ type: "series", page: tab.url }).then((j) => j?.ok && showSeries(j));
  $("edit").onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("editor.html?page=" + encodeURIComponent(tab.url)) });
    window.close();
  };
  $("import").onclick = async () => {
    const wiki = $("wiki").value.trim();
    if (!wiki) return;
    $("import").disabled = true;
    const sub = $("subpages").checked;
    $("imsg").textContent = sub
      ? "Lecture du wiki et des sous-pages… (quelques minutes, tu peux fermer ce popup)"
      : "Lecture du wiki par le LLM… (~20 s)";
    const j = await chrome.runtime.sendMessage({ type: "importWiki", page: tab.url, wiki, subpages: sub });
    $("import").disabled = false;
    $("imsg").textContent = j?.ok ? "Glossaire importé ✔" : "Échec : " + (j?.error || "?");
    if (j?.ok) showSeries({ ...j, wiki });
  };

  $("retranslate").onclick = async () => {
    $("retranslate").disabled = true;
    $("retranslate").textContent = "↻ Retraduction…";
    await chrome.runtime.sendMessage({ type: "retranslate", tabId: tab.id });
    window.close();
  };

  const h = await chrome.runtime.sendMessage({ type: "health" });
  $("status").className = h?.ok ? "ok" : "ko";
  $("status").textContent = h?.ok
    ? `Serveur OK (traduction : ${h.provider}${h.model ? " · " + h.model : ""})`
    : "Serveur éteint — lance start_server.bat";
})();
