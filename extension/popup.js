// KomaTranslator — menu de l'icône: site, langues, traducteur (changement en un clic), police, série, actions.
const $ = (id) => document.getElementById(id);
const P = KomaPresets;

/** Crée un élément: h("button", { class: "x", onclick: fn }, "texte", autreElement). */
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else if (k === "value" || k === "checked" || k === "disabled") e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((x) => x != null && x !== false));
  return e;
}

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

  // ── Site, langues, police ──
  const s = await chrome.storage.sync.get(["sites", "src", "tgt", "font", "caps"]);
  const sites = s.sites || {};
  $("enabled").checked = !!sites[host];
  $("src").value = s.src || "auto";
  $("tgt").value = s.tgt || "fr";
  $("font").value = s.font || "";
  $("caps").checked = !!s.caps;

  $("enabled").onchange = async () => {
    const { sites = {} } = await chrome.storage.sync.get("sites");
    sites[host] = $("enabled").checked;
    await chrome.storage.sync.set({ sites });
  };
  $("src").onchange = () => chrome.storage.sync.set({ src: $("src").value });
  $("tgt").onchange = () => chrome.storage.sync.set({ tgt: $("tgt").value });
  $("font").onchange = () => chrome.storage.sync.set({ font: $("font").value.trim() });
  $("caps").onchange = () => chrome.storage.sync.set({ caps: $("caps").checked });

  // ── Traducteur ──
  let cfg = { ...P.CFG_DEFAULTS, ...((await chrome.storage.local.get("cfg")).cfg || {}) };
  let view = P.activeId(cfg); // traducteur affiché (peut différer de l'actif tant que sa clé manque)
  const save = () => chrome.storage.local.set({ cfg });
  const NAMES = Object.fromEntries(P.PROVIDERS.map((p) => [p.id, p.label]));

  async function refreshStatus() {
    const r = await chrome.runtime.sendMessage({ type: "health" });
    if (r?.ok) {
      $("status").className = "pill " + (r.lastError ? "ko" : "ok");
      $("status").textContent = `Traduction : ${NAMES[P.activeId(cfg)] || r.provider}${r.model ? " · " + r.model : ""}`
        + (r.lastError ? ` — échec, repli Google (${r.lastError})` : "");
    } else {
      $("status").className = "pill ko";
      $("status").textContent = "Extension en cours de démarrage…";
    }
  }

  async function choose(id) {
    view = id;
    if (P.isReady(cfg, id)) { cfg = P.select(cfg, id); await save(); refreshStatus(); }
    render();
  }

  function renderChips() {
    const active = P.activeId(cfg);
    const shown = P.PROVIDERS.filter((p) => p.id !== "custom" || active === "custom" || cfg.profiles?.custom);
    $("chips").replaceChildren(...shown.map((p) => {
      const ready = P.isReady(cfg, p.id);
      const cls = ["chip", p.id === active ? "on" : "", p.id === view && p.id !== active ? "view" : "", ready ? "" : "off"].filter(Boolean).join(" ");
      return h("button", { class: cls, type: "button", onclick: () => choose(p.id) }, p.label, h("small", {}, ready ? p.sub : "clé à ajouter"));
    }));
  }

  function switchRow(label, checked, onchange) {
    const input = h("input", { type: "checkbox", checked });
    input.onchange = () => onchange(input.checked);
    return h("div", { class: "line" }, h("span", {}, label), h("label", { class: "switch" }, input, h("span")));
  }

  function field(label, value, placeholder, onchange) {
    const input = h("input", { value, placeholder, spellcheck: "false" });
    input.onchange = () => onchange(input.value.trim());
    return h("div", { class: "field" }, h("label", {}, label), input);
  }

  function renderProvider() {
    const id = view;
    const kids = [];
    if (id === "google") {
      kids.push(h("div", { class: "muted small" }, "Gratuit, sans clé. Traduction littérale, sans contexte ni glossaire. "
        + "Le point d'accès public peut refuser des requêtes (erreur 429) si on en envoie beaucoup."));
    } else if (!P.isReady(cfg, id)) {
      kids.push(h("div", { class: "notice" }, "Clé manquante : ajoute-la dans les options pour utiliser ce traducteur."),
        h("div", { class: "row" }, h("button", { type: "button", onclick: () => { chrome.runtime.openOptionsPage(); window.close(); } }, "Ouvrir les options")));
    } else {
      kids.push(field("Modèle", P.modelOf(cfg, id), P.PRESETS[id]?.apiModel || "", async (v) => { cfg = P.setModel(cfg, id, v || P.modelOf(P.CFG_DEFAULTS, id)); await save(); refreshStatus(); }));
      if (id === "ollama") {
        kids.push(field("Adresse", cfg.ollamaUrl, "http://localhost:11434", async (v) => { cfg = { ...cfg, ollamaUrl: v || P.CFG_DEFAULTS.ollamaUrl }; await save(); }),
          field("Garder en VRAM", cfg.ollamaKeepAlive || "5m", "5m", async (v) => { cfg = { ...cfg, ollamaKeepAlive: v || "5m" }; await save(); }));
      }
      kids.push(switchRow("Relecture automatique", cfg.review !== false, async (on) => { cfg = { ...cfg, review: on }; await save(); }));
      const out = h("span", { class: "result" });
      const buttons = [h("button", { class: "sec", type: "button", onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; out.className = "result"; out.textContent = "Test en cours…";
        const r = await chrome.runtime.sendMessage({ type: "testProvider", cfg });
        b.disabled = false;
        out.className = "result " + (r?.ok ? "ok" : "ko");
        out.textContent = r?.ok ? `✔ « ${r.result} » (${r.ms} ms)` : "✘ " + (r?.error || "pas de réponse");
      } }, "Tester")];
      if (id === "ollama") {
        buttons.push(h("button", { class: "sec", type: "button", title: "Décharge le modèle de la mémoire graphique maintenant", onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true; out.className = "result"; out.textContent = "…";
          const r = await chrome.runtime.sendMessage({ type: "unloadOllama", cfg });
          b.disabled = false;
          out.className = "result " + (r?.ok ? "ok" : "ko");
          out.textContent = r?.ok ? "Modèle déchargé." : "✘ " + (r?.error || "pas de réponse");
        } }, "Libérer la VRAM"));
      }
      kids.push(h("div", { class: "row" }, ...buttons), h("div", { class: "row" }, out));
      if (P.PRESETS[id]) kids.push(h("div", { class: "muted small", style: "margin-top:8px" }, P.PRESETS[id].note));
    }
    $("prov").replaceChildren(...kids);
  }

  function render() { renderChips(); renderProvider(); }
  render();
  refreshStatus();

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
      ? "Lecture du wiki et des sous-pages… (quelques minutes, tu peux fermer ce menu)"
      : "Lecture du wiki par le LLM… (~20 s)";
    const j = await chrome.runtime.sendMessage({ type: "importWiki", page: tab.url, wiki, subpages: sub });
    $("import").disabled = false;
    $("imsg").textContent = j?.ok ? "Glossaire importé ✔" : "Échec : " + (j?.error || "?");
    if (j?.ok) showSeries({ ...j, wiki });
  };

  // ── Actions ──
  $("retranslate").onclick = async () => {
    $("retranslate").disabled = true;
    $("retranslate").textContent = "↻ Retraduction…";
    await chrome.runtime.sendMessage({ type: "retranslate", tabId: tab.id });
    window.close();
  };
  $("options").onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
})();
