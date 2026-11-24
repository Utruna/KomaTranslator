const test = require("node:test");
const assert = require("node:assert/strict");
const { T } = require("./setup");
require("../extension/engine/ocr.js");
const { groupBlocks, joinLines } = self.KomaOCR._internals;

// Vraies lignes lues par l'OCR (chapitre 130, panneau de statut + une bulle centrée), voir tests/fixtures
const lines = require("./fixtures/panneau-lignes.json");
const texts = (groups) => groups.map((g) => joinLines(g.map((l) => l.text)));

test("panneau de statut: nom/niveau, paragraphes et bulle sont des blocs séparés", () => {
  const out = texts(groupBlocks(lines, false));
  const starts = out.map((t) => t.slice(0, 14));
  // 2 en-têtes + 5 paragraphes de compétences + 1 bulle
  assert.equal(out.length, 8, JSON.stringify(starts));
  assert.ok(out.some((t) => t.startsWith("HUANG YUTIAN") && t.includes("CULTIVATOR IV") && !t.includes("NINE")));
  assert.ok(out.some((t) => t.startsWith("LEVEL:98") && t.includes("HUANG CLAN") && !t.includes("NINE")));
  for (const k of ["PEERLESS NINE", "ICE SWORD", "SWORD LIGHT", "FROST SWORD", "BLOOD SWORD"]) {
    assert.equal(out.filter((t) => t.startsWith(k)).length, 1, k);
  }
});

test("une bulle centrée de 6 lignes reste un seul bloc", () => {
  const bulle = lines.filter((l) => l.box[1] > 1200);
  assert.equal(bulle.length, 6);
  assert.equal(groupBlocks(bulle, false).length, 1);
});

test("dropCredits: retire aussi les fragments de la même rangée", () => {
  const b = (text, box) => ({ text, box });
  const blocks = [
    b("PLEASE", [100, 650, 200, 690]),
    b("READ THIS SERIES ON OUR WEBSITE EN-THUNDERSCANS.COM", [210, 650, 800, 730]),
    b("- THUNDERSCANS", [500, 1050, 700, 1090]),
    b("TEAM", [710, 1052, 780, 1090]),
    b("Salut, ça va ?", [300, 400, 500, 440]),
  ];
  assert.deepEqual(T.dropCredits(blocks).map((x) => x.text), ["Salut, ça va ?"]);
  assert.equal(T.dropCredits([blocks[4]]).length, 1);
});

test("dropCredits: une bulle voisine mais sur une autre rangée est conservée", () => {
  const credit = { text: "discord.gg/abc", box: [100, 900, 400, 940] };
  const bulle = { text: "Attention !", box: [100, 300, 300, 340] };
  assert.deepEqual(T.dropCredits([credit, bulle]).map((x) => x.text), ["Attention !"]);
});
