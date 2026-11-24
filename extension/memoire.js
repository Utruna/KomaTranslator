// KomaTranslator — écran « Mémoire et cache »: séries retenues (wiki, glossaire, corrections, historique) et cache des pages.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

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

function say(text, ok = true) {
  $("msg").className = ok ? "ok" : "ko";
  $("msg").textContent = text;
}

let series = [];

async function loadCache() {
  const r = await send({ type: "cacheInfo" });
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const used = est?.usage ? ` · ${fmt(est.usage)} de stockage utilisés par l'extension` : "";
  $("cacheInfo").textContent = r?.ok ? `${plural(r.count, "page", "pages")} en cache${used}` : "Cache indisponible.";
}

async function run(promise, okText) {
  const r = await promise;
  if (!r?.ok) { say("✘ " + (r?.error || "pas de réponse"), false); return false; }
  say("✔ " + okText);
  await Promise.all([loadSeries(), loadCache()]);
  return true;
}

function render() {
  const q = $("filter").value.trim().toLowerCase();
  const shown = series.filter((s) => !q || s.key.toLowerCase().includes(q) || s.wiki.toLowerCase().includes(q));
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
      s.wiki ? h("span", { class: "tag", title: s.wiki }, "wiki : " + (wikiHost || s.wiki)) : h("span", { class: "tag none" }, "pas de wiki"),
      tag(s.terms, plural(s.terms, "terme", "termes"), "pas de glossaire"),
      tag(s.summary, "résumé", "pas de résumé"),
      tag(s.corrections, plural(s.corrections, "correction", "corrections"), "pas de correction"),
      tag(s.history, plural(s.history, "réplique", "répliques"), "pas d'historique")),
    h("div", { class: "acts" },
      btn("Modifier", "sec", () => chrome.tabs.create({ url: chrome.runtime.getURL("editor.html?page=" + encodeURIComponent("https://" + s.key)) }), "Ouvre l'éditeur de glossaire"),
      !!(s.wiki || s.terms || s.summary) && btn("Retirer le wiki et le glossaire", "sec", () => {
        if (confirm(`Retirer de « ${s.key} » le wiki, le résumé et ${plural(s.terms, "terme", "termes")} de glossaire ?\n\nLes corrections et l'historique sont conservés.`)) {
          run(send({ type: "memClear", key: s.key, part: "wiki" }), "Wiki et glossaire retirés.");
        }
      }, "Efface l'URL du wiki, le résumé et tout le glossaire (importé ou saisi à la main)"),
      s.corrections > 0 && btn("Vider les corrections", "sec", () => {
        if (confirm(`Supprimer les ${plural(s.corrections, "correction manuelle", "corrections manuelles")} de « ${s.key} » ?`)) {
          run(send({ type: "memClear", key: s.key, part: "corrections" }), "Corrections supprimées.");
        }
      }),
      s.history > 0 && btn("Vider l'historique", "sec", () => {
        if (confirm(`Oublier les dernières répliques de « ${s.key} » ?`)) run(send({ type: "memClear", key: s.key, part: "history" }), "Historique vidé.");
      }, "Les dernières répliques servent de contexte aux traductions suivantes"),
      btn("Supprimer la série", "danger", () => {
        if (confirm(`Supprimer toute la mémoire de « ${s.key} » (glossaire, résumé, corrections, historique) ?\n\nCette action est définitive.`)) {
          run(send({ type: "memDelete", key: s.key }), "Série supprimée.");
        }
      })));
}

async function loadSeries() {
  const r = await send({ type: "memList" });
  series = r?.ok ? r.series : [];
  if (!r?.ok) say("✘ " + (r?.error || "pas de réponse"), false);
  render();
}

$("filter").oninput = render;
$("clearCache").onclick = () => {
  if (confirm("Vider le cache des pages traduites ?\n\nLes pages seront retraduites au besoin.")) run(send({ type: "cacheClear" }), "Cache vidé.");
};
loadSeries();
loadCache();
