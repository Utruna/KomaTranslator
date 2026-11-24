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

test("dropCredits: une grande bulle à côté d'un bandeau de crédits n'est pas un fragment (chapitre 131)", () => {
  const credit = { text: "YOU CAN READ THE CHAPTER ON: EN-THUNDERSCANS.COM", box: [93, 6983, 307, 7017] };
  const bulle = { text: "THIS IS IMPOSSIBLE! IN THE WORLD, FINDING A TRUE DRAGON…", box: [415, 6979, 771, 7130] };
  assert.deepEqual(T.dropCredits([credit, bulle]).map((x) => x.text), [bulle.text]);
});

test("dropCredits: une bulle voisine mais sur une autre rangée est conservée", () => {
  const credit = { text: "discord.gg/abc", box: [100, 900, 400, 940] };
  const bulle = { text: "Attention !", box: [100, 300, 300, 340] };
  assert.deepEqual(T.dropCredits([credit, bulle]).map((x) => x.text), ["Attention !"]);
});

// Image synthétique: fond gris, deux « lignes de texte » sombres l'une sous l'autre (4 px d'écart)
function fakeImage() {
  const w = 200, h = 80, data = new Uint8ClampedArray(w * h * 4).fill(200);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  for (const [y0, y1] of [[20, 32], [36, 48]]) {
    for (let y = y0; y < y1; y++) for (let x = 20; x < 150; x++) { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = 30; }
  }
  return { data, width: w, height: h };
}

test("cleanBlock: le masque ne couvre que le texte du bloc, pas celui du voisin", () => {
  const { cleanBlock, withAlpha } = self.KomaOCR._internals;
  const { patchBox, clean, mask } = cleanBlock(fakeImage(), [[20, 20, 150, 32]]);
  const pw = patchBox[2] - patchBox[0];
  const at = (x, y) => mask[(y - patchBox[1]) * pw + (x - patchBox[0])];
  assert.equal(at(80, 26), 1, "le texte du bloc est effacé");
  assert.equal(at(80, 42), 0, "le texte du bloc voisin (dans la marge du patch) n'est pas touché");
  const rgba = withAlpha(clean, mask);
  const a = (x, y) => rgba[((y - patchBox[1]) * pw + (x - patchBox[0])) * 4 + 3];
  assert.equal(a(80, 26), 255);
  assert.equal(a(80, 42), 0, "transparent: ne recouvre pas le patch du voisin");
});

test("deux morceaux collés d'une même ligne restent dans leur paragraphe, dans l'ordre (chapitre 131)", () => {
  const l = (text, box) => ({ text, box, score: 1 });
  const lines = [
    l("ICONTROL: CONTROLSALL", [342, 2780, 659, 2821]),
    l("PUPPETS FORMED BY FALLEN SACRED", [106, 2826, 694, 2870]),
    l("CORPSE-DRAGON", [140, 2780, 354, 2820]),
    l("DRAGONS, CAN SUMMON OR DISMISS", [110, 2874, 690, 2915]),
  ];
  const out = texts(groupBlocks(lines, false));
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.ok(out[0].startsWith("CORPSE-DRAGON ICONTROL"), out[0]);
});

test("lignes très penchées empilées: ordre de haut en bas, pas côte à côte (chapitre 131)", () => {
  const l = (text, box) => ({ text, box, score: 1 });
  const lines = [
    l("IVE NEVER FEARED", [438, 4428, 758, 4518]),
    l("OUTNUMBERED?", [463, 4400, 729, 4478]),
    l("THE ODDS!", [517, 4475, 693, 4538]),
  ];
  assert.deepEqual(texts(groupBlocks(lines, false)), ["OUTNUMBERED? IVE NEVER FEARED THE ODDS!"]);
});
