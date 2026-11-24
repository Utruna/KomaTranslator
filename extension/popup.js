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
  const s = await chrome.storage.sync.get(["sites", "src", "tgt", "font", "caps", "eco", "siteLangs"]);
  const sites = s.sites || {};
  $("enabled").checked = !!sites[host];
  const LANGS = { auto: "Auto", zh: "Chinois", ja: "Japonais", ko: "Coréen", en: "Anglais" };
  $("src").options[0].textContent = `Général (${LANGS[s.src || "auto"] || s.src})`; // réglage de la page d'options
  $("src").value = (s.siteLangs || {})[host]?.src || "";
  $("eco").checked = !!s.eco;
  $("tgt").value = s.tgt || "fr";
  $("font").value = s.font || "";
  $("caps").checked = !!s.caps;

  $("enabled").onchange = async () => {
    const { sites = {} } = await chrome.storage.sync.get("sites");
    sites[host] = $("enabled").checked;
    await chrome.storage.sync.set({ sites });
  };
  // La langue source se règle par site (siteLangs); « Général » retire l'exception de ce site.
  $("src").onchange = async () => {
    const { siteLangs = {} } = await chrome.storage.sync.get("siteLangs");
    if ($("src").value) siteLangs[host] = { ...(siteLangs[host] || {}), src: $("src").value }; else delete siteLangs[host];
    await chrome.storage.sync.set({ siteLangs });
  };
  $("eco").onchange = () => chrome.storage.sync.set({ eco: $("eco").checked });
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

  function render() { renderChips(); renderProvider(); renderUsage(); }

  // ── Consommation: jetons, coût estimé, plafond, solde ──
  const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + " M" : n >= 1e3 ? Math.round(n / 1e3) + " k" : String(n));
  const cents = (usd) => { const c = usd * 100; return (c < 10 ? c.toFixed(2) : c.toFixed(1)).replace(".", ",") + " ¢"; };
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "à l'instant" : m < 90 ? `il y a ${m} min` : `il y a ${Math.round(m / 60)} h`; };

  async function renderUsage() {
    const card = $("usageCard");
    const id = P.activeId(cfg);
    if (id === "google") { card.hidden = true; return; }
    card.hidden = false;
    const r = await chrome.runtime.sendMessage({ type: "usageInfo" });
    const u = r?.ok ? r.usage : { today: {}, month: {}, days: [] };
    const price = P.priceOf(cfg);
    const t = u.today[id] || { req: 0, tin: 0, tout: 0, pages: 0, cost: 0 }, m = u.month[id] || { req: 0, tin: 0, tout: 0, pages: 0, cost: 0 };
    const line = (label, x) => h("div", { class: "kv" }, h("span", {}, label),
      h("b", {}, `${x.pages} pages · ${tok(x.tin + x.tout)} jetons${price ? " · ≈ " + cents(x.cost) : ""}`));
    const todayCost = Object.values(u.today).reduce((a, x) => a + (x.cost || 0), 0);
    $("usageSum").textContent = price ? `aujourd'hui ≈ ${cents(t.cost)}` : `${tok(t.tin + t.tout)} jetons aujourd'hui`;
    const kids = [line("Aujourd'hui", t), line("Ce mois-ci", m)];
    kids.push(h("div", { class: "muted small" }, price ? `Tarif : ${price.label}${price.in || price.out ? ` (${price.in} / ${price.out} $ par million de jetons)` : ""}. Estimation, hors cache du fournisseur.` : "Tarif inconnu : renseigne-le pour estimer le coût."));
    if (!price || cfg.priceIn !== "" || cfg.priceOut !== "") {
      const pin = h("input", { type: "number", min: "0", step: "any", value: cfg.priceIn ?? "", placeholder: "0" });
      const pout = h("input", { type: "number", min: "0", step: "any", value: cfg.priceOut ?? "", placeholder: "0" });
      const savePrice = async () => { cfg = { ...cfg, priceIn: pin.value, priceOut: pout.value }; await save(); renderUsage(); };
      pin.onchange = savePrice; pout.onchange = savePrice;
      kids.push(h("div", { class: "inline" }, "Tarif $ / M jetons : entrée", pin, "sortie", pout));
    }
    const cap = h("input", { type: "number", min: "0", step: "1", value: cfg.dailyCapCents || 0 });
    cap.onchange = async () => { cfg = { ...cfg, dailyCapCents: Math.max(0, Number(cap.value) || 0) }; await save(); renderUsage(); };
    kids.push(h("div", { class: "inline" }, "Plafond par jour :", cap, "¢ (0 = aucun)"));
    if (cfg.dailyCapCents > 0) {
      const over = todayCost * 100 >= cfg.dailyCapCents;
      kids.push(h("div", { class: "notice", style: over ? "" : "background:var(--accent-soft);color:var(--fg)" },
        over ? `Plafond atteint (${cents(todayCost)}) : Google prend le relais jusqu'à demain (UTC).` : `Dépensé aujourd'hui : ${cents(todayCost)} sur ${cfg.dailyCapCents} ¢. Au-delà : repli sur Google.`));
    }
    if (id === "deepseek" && P.isReady(cfg, "deepseek")) {
      const cache = (await chrome.storage.local.get("balanceCache")).balanceCache;
      const out = h("span", { class: "result" });
      const fmt = (b) => cache ? b.balances.map((x) => `${x.total.toFixed(2)} ${x.currency === "USD" ? "$" : x.currency}`).join(" + ") : "";
      if (cache) { out.className = "result " + (cache.available ? "ok" : "ko"); out.textContent = `Solde : ${fmt(cache)}${cache.available ? "" : " (insuffisant)"} · ${ago(cache.at)}`; }
      kids.push(h("div", { class: "row" }, h("button", { class: "sec", type: "button", onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; out.className = "result"; out.textContent = "…";
        const r2 = await chrome.runtime.sendMessage({ type: "balance" });
        b.disabled = false;
        if (r2?.ok) renderUsage(); else { out.className = "result ko"; out.textContent = "✘ " + (r2?.error || "pas de réponse"); }
      } }, "Actualiser le solde"), out));
    }
    kids.push(h("div", { class: "row" }, h("a", { href: chrome.runtime.getURL("memoire.html#conso"), target: "_blank", class: "small" }, "Détail par jour…")));
    $("usageBody").replaceChildren(...kids);
  }
  render();
  refreshStatus();

  // ── Cette page: progression, pause, voir l'original, erreurs ──
  const toTab = (cmd) => chrome.tabs.sendMessage(tab.id, { type: "koma", cmd }).catch(() => {});
  async function refreshStats() {
    const r = await chrome.runtime.sendMessage({ type: "tabStats", tabId: tab.id });
    const st = r?.ok ? r.stats : null;
    const on = !!(st?.enabled && $("enabled").checked);
    $("pause").disabled = $("orig").disabled = !on;
    $("pause").textContent = st?.paused ? "▶ Reprendre" : "⏸ Pause";
    $("orig").textContent = st?.original ? "🌐 Voir la traduction" : "👁 Voir l'original";
    if (!on) {
      $("progress").textContent = $("enabled").checked ? "En attente d'images à traduire…" : "Traduction désactivée sur ce site.";
      $("barFill").style.width = "0";
      $("errs").hidden = true;
      return;
    }
    const parts = [`${st.done} / ${st.tracked} images traduites`];
    if (st.busy) parts.push(`${st.busy} en cours`);
    if (st.queued) parts.push(`${st.queued} en attente`);
    if (st.empty) parts.push(`${st.empty} sans texte`);
    $("progress").textContent = (st.paused ? "⏸ En pause · " : "") + parts.join(" · ");
    $("barFill").style.width = st.tracked ? Math.round(((st.done + st.empty) / st.tracked) * 100) + "%" : "0";
    $("errs").hidden = !st.failed;
    if (st.failed) {
      $("errCount").textContent = `${st.failed} image${st.failed > 1 ? "s" : ""} en échec`;
      $("errList").replaceChildren(...st.errors.map((e) => h("div", {}, `${e.url} : ${e.error}`)),
        ...(st.failed > st.errors.length ? [h("div", {}, `… et ${st.failed - st.errors.length} autres`)] : []),
        h("div", {}, "Alt+Maj+clic sur une image la retraduit."));
    }
    last = st;
  }
  let last = null;
  $("pause").onclick = async () => { await toTab(last?.paused ? "resume" : "pause"); setTimeout(refreshStats, 250); };
  $("orig").onclick = async () => { await toTab(last?.original ? "translated" : "original"); setTimeout(refreshStats, 250); };
  refreshStats();
  setInterval(refreshStats, 1000);

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
  $("memory").onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL("memoire.html") }); window.close(); };
  $("options").onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
})();
