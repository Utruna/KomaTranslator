// KomaTranslator — écran « Mémoire et cache »: séries retenues (wiki, glossaire, corrections, historique) et cache des pages.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const LANGS = { fr: "Français", en: "Anglais", es: "Espagnol", de: "Allemand", it: "Italien", pt: "Portugais" };
const langName = (l) => LANGS[l] || l;

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((x) => x != null && x !== false));
  return e;
}

const fmt = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " Mo" : bytes >= 1024 ? Math.round(bytes / 1024) + " Ko" : bytes + " o");
const plural = (n, un, plus) => `${n} ${n > 1 ? plus : un}`;

/** Message d'état; avec `undo`, un bouton « Annuler » rétablit ce qui vient d'être supprimé. */
function say(text, ok = true, undo = null) {
  $("msg").className = ok ? "ok" : "ko";
  $("msg").replaceChildren(text, ...(undo ? [h("button", { class: "sec", type: "button", onclick: undo }, "Annuler")] : []));
}

let series = [];

async function loadCache() {
  const r = await send({ type: "cacheInfo" });
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const used = est?.usage ? ` · ${fmt(est.usage)} de stockage utilisés par l'extension` : "";
  $("cacheInfo").textContent = r?.ok ? `${plural(r.count, "page", "pages")} en cache${used}` : "Cache indisponible.";
}

async function refresh() { await Promise.all([loadSeries(), loadCache()]); }

/** Action sans retour possible (cache). */
async function run(promise, okText) {
  const r = await promise;
  if (!r?.ok) { say("✘ " + (r?.error || "pas de réponse"), false); return false; }
  say("✔ " + okText);
  await refresh();
  return true;
}

/** Action sur une série: on garde son état d'avant pour pouvoir l'annuler. */
async function destructive(key, msg, okText) {
  const before = (await send({ type: "memGet", key }))?.serie;
  const r = await send(msg);
  if (!r?.ok) { say("✘ " + (r?.error || "pas de réponse"), false); return; }
  await refresh();
  say("✔ " + okText, true, before && (async () => {
    const r2 = await send({ type: "memPut", serie: before });
    if (r2?.ok) { await refresh(); say("↩ Série restaurée."); } else say("✘ " + (r2?.error || "pas de réponse"), false);
  }));
}

function download(name, obj) {
  const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
const stamp = () => new Date().toISOString().slice(0, 10);

async function exportKeys(keys, name) {
  const r = await send({ type: "memExport", keys });
  if (!r?.ok) { say("✘ " + (r?.error || "pas de réponse"), false); return; }
  download(name, r.data);
  say(`✔ ${plural(r.data.series.length, "série exportée", "séries exportées")} (${name}).`);
}

function render() {
  const q = $("filter").value.trim().toLowerCase();
  const lang = $("langFilter").value;
  const shown = series.filter((s) => (!q || s.key.toLowerCase().includes(q) || s.wiki.toLowerCase().includes(q))
    && (!lang || (s.langs || []).includes(lang)));
  $("total").textContent = `(${series.length}${shown.length !== series.length ? `, ${shown.length} affichées` : ""})`;
  $("list").replaceChildren(...(shown.length ? shown.map(card) : [h("div", { class: "muted", style: "margin-top:10px" }, series.length ? "Aucune série ne correspond." : "Aucune série retenue pour l'instant.")]));
}

function card(s) {
  let wikiHost = "";
  try { wikiHost = new URL(s.wiki).hostname; } catch {}
  const tag = (n, label, empty) => h("span", { class: "tag" + (n ? "" : " none") }, n ? label : empty);
  const btn = (label, cls, fn, title) => h("button", { class: cls, type: "button", title: title || "", onclick: fn }, label);
  return h("div", { class: "serie" },
    h("span", { class: "size" }, fmt(s.bytes)),
    h("b", {}, s.key),
    h("div", { class: "meta" },
      ...(s.langs || []).map((l) => h("span", { class: "tag lang", title: "Traduit en " + langName(l) }, l.toUpperCase())),
      s.wiki ? h("span", { class: "tag", title: s.wiki }, "wiki : " + (wikiHost || s.wiki)) : h("span", { class: "tag none" }, "pas de wiki"),
      tag(s.terms, plural(s.terms, "terme", "termes"), "pas de glossaire"),
      tag(s.summary, "résumé", "pas de résumé"),
      tag(s.corrections, plural(s.corrections, "correction", "corrections"), "pas de correction"),
      tag(s.history, plural(s.history, "réplique", "répliques"), "pas d'historique")),
    h("div", { class: "acts" },
      btn("Exporter", "sec", () => exportKeys([s.key], `komatranslator-${s.key.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.json`), "Fichier à partager ou à garder"),
      btn("Modifier", "sec", () => chrome.tabs.create({ url: chrome.runtime.getURL("editor.html?page=" + encodeURIComponent("https://" + s.key)) }), "Ouvre l'éditeur de glossaire"),
      !!(s.wiki || s.terms || s.summary) && btn("Retirer le wiki et le glossaire", "sec", () => {
        if (confirm(`Retirer de « ${s.key} » le wiki, le résumé et ${plural(s.terms, "terme", "termes")} de glossaire ?\n\nLes corrections et l'historique sont conservés.`)) {
          destructive(s.key, { type: "memClear", key: s.key, part: "wiki" }, "Wiki et glossaire retirés.");
        }
      }, "Efface l'URL du wiki, le résumé et tout le glossaire (importé ou saisi à la main)"),
      s.corrections > 0 && btn("Vider les corrections", "sec", () => {
        if (confirm(`Supprimer les ${plural(s.corrections, "correction manuelle", "corrections manuelles")} de « ${s.key} » ?`)) {
          destructive(s.key, { type: "memClear", key: s.key, part: "corrections" }, "Corrections supprimées.");
        }
      }),
      s.history > 0 && btn("Vider l'historique", "sec", () => {
        if (confirm(`Oublier les dernières répliques de « ${s.key} » ?`)) destructive(s.key, { type: "memClear", key: s.key, part: "history" }, "Historique vidé.");
      }, "Les dernières répliques servent de contexte aux traductions suivantes"),
      btn("Supprimer la série", "danger", () => {
        if (confirm(`Supprimer toute la mémoire de « ${s.key} » (glossaire, résumé, corrections, historique) ?\n\nCette action est définitive.`)) {
          destructive(s.key, { type: "memDelete", key: s.key }, "Série supprimée.");
        }
      })));
}

async function loadSeries() {
  const r = await send({ type: "memList" });
  series = r?.ok ? r.series : [];
  if (!r?.ok) say("✘ " + (r?.error || "pas de réponse"), false);
  // menu des langues: seulement celles présentes (le choix en cours est gardé)
  const sel = $("langFilter"), cur = sel.value;
  const langs = [...new Set(series.flatMap((s) => s.langs || []))].sort();
  sel.replaceChildren(h("option", { value: "" }, "Toutes les langues"), ...langs.map((l) => h("option", { value: l }, langName(l))));
  sel.value = langs.includes(cur) ? cur : "";
  sel.hidden = langs.length < 2;
  render();
}

// ── Consommation ──
const cents = (usd) => { const c = usd * 100; return (c < 10 ? c.toFixed(2) : c.toFixed(1)).replace(".", ",") + " ¢"; };
const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + " M" : n >= 1e3 ? Math.round(n / 1e3) + " k" : String(n));
async function loadUsage() {
  const r = await send({ type: "usageInfo" });
  const days = (r?.ok ? r.usage.days : []).slice(0, 30);
  if (!days.length) { $("usageTable").replaceChildren(h("div", { class: "muted", style: "margin-top:10px" }, "Aucune consommation enregistrée.")); return; }
  const tot = days.reduce((a, d) => ({ pages: a.pages + d.pages, tin: a.tin + d.tin, tout: a.tout + d.tout, cost: a.cost + d.cost }), { pages: 0, tin: 0, tout: 0, cost: 0 });
  const row = (cells, tag = "td") => h("tr", {}, ...cells.map((c) => h(tag, {}, c)));
  $("usageTable").replaceChildren(h("table", {},
    row(["Jour (UTC)", "Pages", "Jetons entrée", "Jetons sortie", "Coût estimé"], "th"),
    ...days.map((d) => row([d.day, String(d.pages), tok(d.tin), tok(d.tout), cents(d.cost)])),
    row([`Total (${days.length} jours)`, String(tot.pages), tok(tot.tin), tok(tot.tout), cents(tot.cost)], "th")));
}
$("resetUsage").onclick = async () => {
  if (confirm("Remettre le compteur de consommation à zéro ?\n\nCela ne change rien chez ton fournisseur.")) {
    const r = await send({ type: "usageReset" });
    say(r?.ok ? "✔ Compteur réinitialisé." : "✘ " + (r?.error || "pas de réponse"), !!r?.ok);
    loadUsage();
  }
};

// ── Sauvegarde et partage ──
$("exportAll").onclick = () => exportKeys(null, `komatranslator-series-${stamp()}.json`);
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
  const file = $("importFile").files[0];
  $("importFile").value = "";
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { say("✘ Ce fichier n'est pas du JSON valide.", false); return; }
  if (data?.app !== "KomaTranslator" || !Array.isArray(data.series)) { say("✘ Ce fichier n'est pas un export KomaTranslator.", false); return; }
  if (!confirm(`Importer ${plural(data.series.length, "série", "séries")} depuis « ${file.name} » ?\n\nLe glossaire importé complète le tien ; tes corrections et ton résumé restent prioritaires.`)) return;
  // état d'avant, pour pouvoir annuler: séries existantes restaurées, nouvelles supprimées
  const keys = data.series.map((x) => x?.key).filter((k) => typeof k === "string" && k.trim());
  const known = new Set(series.map((x) => x.key));
  const before = keys.length <= 100 ? await Promise.all(keys.filter((k) => known.has(k)).map(async (k) => (await send({ type: "memGet", key: k }))?.serie)) : null;
  const r = await send({ type: "memImport", data });
  if (!r?.ok) { say("✘ " + (r?.error || "pas de réponse"), false); return; }
  await refresh();
  const { added, merged, skipped } = r.result;
  say(`✔ ${plural(added, "série ajoutée", "séries ajoutées")}, ${plural(merged, "fusionnée", "fusionnées")}${skipped ? `, ${skipped} ignorée${skipped > 1 ? "s" : ""}` : ""}.`, true, before && (async () => {
    for (const k of keys) if (!known.has(k)) await send({ type: "memDelete", key: k });
    for (const serie of before) if (serie) await send({ type: "memPut", serie });
    await refresh();
    say("↩ Import annulé.");
  }));
};

$("filter").oninput = render;
$("langFilter").onchange = render;
$("clearCache").onclick = () => {
  if (confirm("Vider le cache des pages traduites ?\n\nLes pages seront retraduites au besoin.")) run(send({ type: "cacheClear" }), "Cache vidé.");
};
loadSeries();
loadCache();
loadUsage();
if (location.hash === "#conso") setTimeout(() => $("conso").scrollIntoView(), 300);
