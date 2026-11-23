const $ = (id) => document.getElementById(id);
const page = new URLSearchParams(location.search).get("page") || "";
const FIELDS = ["src", "orig", "tgt", "type", "note"];
let server = "http://127.0.0.1:8765";

function cell(value, field) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  input.dataset.field = field;
  td.appendChild(input);
  return td;
}

function delCell(tr, onDel) {
  const td = document.createElement("td");
  const b = document.createElement("button");
  b.className = "del";
  b.title = "Supprimer";
  b.textContent = "✕";
  b.onclick = () => { tr.remove(); onDel?.(); };
  td.appendChild(b);
  return td;
}

function addTerm(t = {}, top = false) {
  const tr = document.createElement("tr");
  FIELDS.forEach((f) => tr.appendChild(cell(t[f], f)));
  tr.appendChild(delCell(tr, count));
  top ? $("terms").prepend(tr) : $("terms").appendChild(tr);
  count();
  return tr;
}

function addFix(text, tr) {
  const row = document.createElement("tr");
  row.appendChild(cell(text, "text"));
  row.appendChild(cell(tr, "translation"));
  row.appendChild(delCell(row, count));
  $("fixes").appendChild(row);
}

function count() {
  $("count").textContent = $("terms").rows.length;
  $("ccount").textContent = $("fixes").rows.length;
}

function readRows(tbody, fields) {
  return [...tbody.rows].map((tr) => {
    const o = {};
    tr.querySelectorAll("input").forEach((i) => (o[i.dataset.field] = i.value.trim()));
    return o;
  });
}

$("filter").oninput = () => {
  const q = $("filter").value.toLowerCase();
  for (const tr of $("terms").rows) {
    const txt = [...tr.querySelectorAll("input")].map((i) => i.value).join(" ").toLowerCase();
    tr.hidden = q && !txt.includes(q);
  }
};
$("add").onclick = () => addTerm({}, true).querySelector("input").focus();

$("save").onclick = async () => {
  $("msg").textContent = "Enregistrement…";
  const corrections = {};
  readRows($("fixes")).forEach((r) => { if (r.text && r.translation) corrections[r.text] = r.translation; });
  const body = {
    page,
    summary: $("summary").value,
    glossary: readRows($("terms")).filter((t) => t.src && t.tgt),
    corrections,
    clear_history: $("clearHist").checked,
  };
  try {
    const r = await fetch(`${server}/series/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    $("msg").textContent = "Enregistré ✔ (les prochaines pages utiliseront ce glossaire)";
    if ($("clearHist").checked) { $("history").innerHTML = ""; $("clearHist").checked = false; }
  } catch (e) {
    $("msg").textContent = "Échec : " + e.message;
  }
};

(async () => {
  const s = await chrome.storage.sync.get("server");
  if (s.server) server = s.server;
  try {
    const d = await (await fetch(`${server}/series/full?page=${encodeURIComponent(page)}`)).json();
    $("key").textContent = d.key + (d.wiki ? ` · wiki : ${d.wiki}` : "");
    document.title = "Glossaire — " + d.key.split("/").pop();
    $("summary").value = d.summary || "";
    (d.glossary || []).forEach((t) => addTerm(t));
    Object.entries(d.corrections || {}).forEach(([k, v]) => addFix(k, v));
    for (const [a, b] of (d.history || []).slice().reverse()) {
      const li = document.createElement("li");
      li.textContent = `${a} → ${b}`;
      $("history").appendChild(li);
    }
    count();
  } catch {
    $("key").textContent = "Serveur injoignable — lance start_server.bat";
  }
})();
